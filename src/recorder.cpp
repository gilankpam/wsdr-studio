// SPDX-License-Identifier: GPL-2.0-only
#include "recorder.h"

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <stdexcept>

#include <nlohmann/json.hpp>

namespace studio {

namespace {
constexpr size_t kMaxQueued = 32u << 20; // int16 values (64 MiB) before samples are dropped
}

std::string Recorder::start(double fs, double centre_hz, const std::string &hw, int path, double gain_db, bool agc) {
  stop();
  std::filesystem::create_directories(_dir);
  const std::time_t now = std::time(nullptr);
  std::tm tm{};
  gmtime_r(&now, &tm);
  char stamp[32], dt[32], name[160];
  std::strftime(stamp, sizeof stamp, "%Y%m%d-%H%M%S", &tm);
  std::strftime(dt, sizeof dt, "%Y-%m-%dT%H:%M:%SZ", &tm);
  std::snprintf(name, sizeof name, "wsdr-%s-%.3fMHz-%gMsps%s", stamp, centre_hz / 1e6, fs / 1e6, path ? "-B" : "");
  std::string base;
  int fd = -1;
  for (int n = 1; fd < 0 && n < 100; n++) { // two recordings in the same second get -2, -3, ...
    base = (std::filesystem::path(_dir) / name).string() + (n > 1 ? "-" + std::to_string(n) : "");
    fd = ::open((base + ".sigmf-data").c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd < 0 && errno != EEXIST)
      break;
  }
  if (fd < 0)
    throw std::runtime_error(std::string("recording: ") + std::strerror(errno));
  {
    std::lock_guard<std::mutex> l(_m);
    _base = base;
    _datetime = dt;
    _fs = fs;
    _centre = centre_hz;
    _hw = hw;
    _path = path;
    _gain = gain_db;
    _agc = agc;
    _error.clear();
    _q.clear();
    _queued = 0;
    _quit = false;
    _fd = fd;
  }
  write_meta(false);
  _samples = 0;
  _dropped = 0;
  _failed = false;
  _active = true;
  _t = std::thread([this] { writer(); });
  return base + ".sigmf-data";
}

bool Recorder::stop() {
  if (!_t.joinable())
    return false;
  _active = false; // push() stops queueing; the writer drains what is queued
  {
    std::lock_guard<std::mutex> l(_m);
    _quit = true;
  }
  _cv.notify_all();
  _t.join();
  {
    std::lock_guard<std::mutex> l(_m);
    if (::close(_fd) != 0 && _error.empty())
      _error = std::string("closing the file failed: ") + std::strerror(errno);
    _fd = -1;
  }
  write_meta(true);
  return true;
}

void Recorder::push(const int16_t *iq, size_t samples) {
  if (!_active || _failed)
    return;
  {
    std::lock_guard<std::mutex> l(_m);
    if (_quit || _queued + 2 * samples > kMaxQueued) {
      _dropped += samples;
      return;
    }
    _q.emplace_back(iq, iq + 2 * samples);
    _queued += 2 * samples;
  }
  _cv.notify_one();
}

void Recorder::writer() {
  int fd;
  {
    std::lock_guard<std::mutex> l(_m);
    fd = _fd;
  }
  for (;;) {
    std::vector<int16_t> b;
    {
      std::unique_lock<std::mutex> l(_m);
      _cv.wait(l, [&] { return !_q.empty() || _quit; });
      if (_q.empty())
        return;
      b = std::move(_q.front());
      _q.pop_front();
      _queued -= b.size();
    }
    if (_failed) {
      _dropped += b.size() / 2;
      continue;
    }
    const char *p = reinterpret_cast<const char *>(b.data());
    size_t left = b.size() * sizeof(int16_t);
    while (left) {
      const ssize_t w = ::write(fd, p, left);
      if (w < 0 && errno == EINTR)
        continue;
      if (w <= 0) {
        std::lock_guard<std::mutex> l(_m);
        _error = std::string("write failed: ") + (w < 0 ? std::strerror(errno) : "no space");
        _failed = true;
        break;
      }
      p += w;
      left -= static_cast<size_t>(w);
      _samples += static_cast<uint64_t>(w) / 4; // only what reached the file
    }
    if (left)
      _dropped += left / 4;
  }
}

void Recorder::write_meta(bool final) {
  std::lock_guard<std::mutex> l(_m);
  nlohmann::json g = {{"core:datatype", "ci16_le"},
                      {"core:sample_rate", _fs},
                      {"core:version", "1.0.0"},
                      {"core:hw", _hw},
                      {"core:recorder", "wsdr-studio"},
                      {"core:description", std::string("LA-mode baseband samples, path ") + (_path ? "B" : "A") +
                                               ", 12-bit values << 4, DC not removed; gain " +
                                               (_agc ? std::string("AGC") : std::to_string(_gain) + " dB (fixed)")}};
  if (final) {
    g["wsdr:samples"] = _samples.load();
    g["wsdr:dropped_samples"] = _dropped.load();
    if (!_error.empty())
      g["wsdr:error"] = _error;
  }
  const nlohmann::json meta = {
      {"global", g},
      {"captures", {{{"core:sample_start", 0}, {"core:frequency", _centre}, {"core:datetime", _datetime}}}},
      {"annotations", nlohmann::json::array()}};
  // temp file + rename: a full disk leaves the previous meta file intact rather than a truncated one
  const std::string tmp = _base + ".sigmf-meta.tmp";
  {
    std::ofstream f(tmp, std::ios::trunc);
    f << meta.dump(2) << "\n";
    f.flush();
    if (!f) {
      std::filesystem::remove(tmp);
      if (_error.empty())
        _error = "writing the metadata file failed";
      return;
    }
  }
  std::filesystem::rename(tmp, _base + ".sigmf-meta");
}

RecordInfo Recorder::info() const {
  std::lock_guard<std::mutex> l(_m);
  RecordInfo i;
  i.active = _active;
  i.path = _base.empty() ? "" : _base + ".sigmf-data";
  i.samples = _samples;
  i.dropped = _dropped;
  i.fs = _fs;
  i.error = _error;
  return i;
}

} // namespace studio
