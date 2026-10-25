// SPDX-License-Identifier: GPL-2.0-only
#include "recorder.h"

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
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
  _base = (std::filesystem::path(_dir) / name).string();
  _datetime = dt;
  _fs = fs;
  _centre = centre_hz;
  _hw = hw;
  _path = path;
  _gain = gain_db;
  _agc = agc;
  _fd = ::open((_base + ".sigmf-data").c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
  if (_fd < 0)
    throw std::runtime_error(std::string("recording: ") + std::strerror(errno));
  write_meta(false);
  _samples = 0;
  _dropped = 0;
  _quit = false;
  _active = true;
  _t = std::thread([this] { writer(); });
  return _base + ".sigmf-data";
}

void Recorder::stop() {
  if (!_t.joinable())
    return;
  {
    std::lock_guard<std::mutex> l(_m);
    _quit = true;
  }
  _cv.notify_all();
  _t.join();
  _active = false;
  ::close(_fd);
  _fd = -1;
  write_meta(true);
}

void Recorder::push(const int16_t *iq, size_t samples) {
  if (!_active)
    return;
  {
    std::lock_guard<std::mutex> l(_m);
    if (_queued + 2 * samples > kMaxQueued) {
      _dropped += samples;
      return;
    }
    _q.emplace_back(iq, iq + 2 * samples);
    _queued += 2 * samples;
  }
  _cv.notify_one();
}

void Recorder::writer() {
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
    const char *p = reinterpret_cast<const char *>(b.data());
    size_t left = b.size() * 2;
    while (left) {
      const ssize_t w = ::write(_fd, p, left);
      if (w <= 0) {
        if (errno == EINTR)
          continue;
        _dropped += left / 4;
        break;
      }
      p += w;
      left -= static_cast<size_t>(w);
    }
    _samples += b.size() / 2;
  }
}

void Recorder::write_meta(bool final) {
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
  }
  const nlohmann::json meta = {
      {"global", g},
      {"captures", {{{"core:sample_start", 0}, {"core:frequency", _centre}, {"core:datetime", _datetime}}}},
      {"annotations", nlohmann::json::array()}};
  std::ofstream f(_base + ".sigmf-meta");
  f << meta.dump(2) << "\n";
}

RecordInfo Recorder::info() const {
  RecordInfo i;
  i.active = _active;
  i.path = _base.empty() ? "" : _base + ".sigmf-data";
  i.samples = _samples;
  i.dropped = _dropped;
  i.fs = _fs;
  i.centre_hz = _centre;
  return i;
}

} // namespace studio
