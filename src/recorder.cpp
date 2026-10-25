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
  const std::string base = (std::filesystem::path(_dir) / name).string();
  const int fd = ::open((base + ".sigmf-data").c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
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

void Recorder::stop() {
  if (!_t.joinable())
    return;
  _active = false; // push() stops queueing; the writer drains what is queued
  {
    std::lock_guard<std::mutex> l(_m);
    _quit = true;
  }
  _cv.notify_all();
  _t.join();
  {
    std::lock_guard<std::mutex> l(_m);
    ::close(_fd);
    _fd = -1;
  }
  write_meta(true);
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
  std::ofstream f(_base + ".sigmf-meta");
  f << meta.dump(2) << "\n";
}

RecordInfo Recorder::info() const {
  std::lock_guard<std::mutex> l(_m);
  RecordInfo i;
  i.active = _active;
  i.path = _base.empty() ? "" : _base + ".sigmf-data";
  i.samples = _samples;
  i.dropped = _dropped;
  i.fs = _fs;
  i.centre_hz = _centre;
  i.error = _error;
  return i;
}

} // namespace studio
