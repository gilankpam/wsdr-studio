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
constexpr size_t kMaxQueued = 64u << 20;    // int16 values (128 MiB) queued before samples are dropped
constexpr uint64_t kFlushBlock = 16u << 20; // writeback granularity (bytes)
constexpr uint64_t kFlushLag = 6;           // wait for the block this far behind (~96 MiB in flight)
// At 40 MS/s (160 MB/s) the queue plus the blocks in flight ride out ~1.4 s of disk stall.
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
    _meta_error.clear();
    _q.clear();
    _queued = 0;
    _quit = false;
    _fd = fd;
    _bytes = 0; // under the lock with _base: info() never pairs the new file with the old size
    _dropped = 0;
    _failed = false;
  }
  write_meta(false);
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
  // The writer is gone and push() never touches the fd: finish the file WITHOUT holding _m (info() is
  // read from the I/O thread twice a second; an fsync can take a while).
  int fd;
  {
    std::lock_guard<std::mutex> l(_m);
    fd = _fd;
    _fd = -1;
  }
  std::string err;
  const uint64_t whole = _bytes.load() / 4 * 4; // a short write must not leave half a sample
  if (whole != _bytes.load() && ::ftruncate(fd, static_cast<off_t>(whole)) == 0)
    _bytes = whole;
  if (::fsync(fd) != 0)
    err = std::string("flushing the file failed: ") + std::strerror(errno);
  if (::close(fd) != 0 && err.empty())
    err = std::string("closing the file failed: ") + std::strerror(errno);
  if (!err.empty()) {
    std::lock_guard<std::mutex> l(_m);
    if (_error.empty())
      _error = err;
  }
  write_meta(true);
  return true;
}

void Recorder::push(const int16_t *iq, size_t samples) {
  if (!_active || _failed)
    return;
  {
    std::lock_guard<std::mutex> l(_m);
    if (_quit)
      return; // stopping: these were never part of the file
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
  uint64_t flushed = 0; // 16 MiB blocks handed to writeback
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
      _bytes += static_cast<uint64_t>(w); // only what reached the file
    }
    // Flush behind: start writeback of each finished 16 MiB block and wait for the one kFlushLag blocks
    // before it, so dirty pages stay bounded (no huge fsync at stop) while short stalls are absorbed.
    // A writeback error is reported to these calls (and then not again to fsync): treat it as a write
    // failure.
    const uint64_t done = _bytes.load() / kFlushBlock;
    while (flushed < done && !_failed) {
      int rc = ::sync_file_range(fd, static_cast<off_t>(flushed * kFlushBlock), kFlushBlock, SYNC_FILE_RANGE_WRITE);
      if (rc == 0 && flushed >= kFlushLag) {
        const off_t prev = static_cast<off_t>((flushed - kFlushLag) * kFlushBlock);
        rc = ::sync_file_range(fd, prev, kFlushBlock,
                               SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE | SYNC_FILE_RANGE_WAIT_AFTER);
        if (rc == 0)
          ::posix_fadvise(fd, prev, kFlushBlock, POSIX_FADV_DONTNEED);
      }
      if (rc != 0) {
        std::lock_guard<std::mutex> l(_m);
        _error = std::string("write failed: ") + std::strerror(errno);
        _failed = true;
        break;
      }
      flushed++;
    }
    if (left)
      _dropped += (left + 3) / 4;
  }
}

void Recorder::write_meta(bool final) {
  // Build under the lock, write without it (info() is read twice a second from the I/O thread).
  std::unique_lock<std::mutex> l(_m);
  nlohmann::json g = {{"core:datatype", "ci16_le"},
                      {"core:sample_rate", _fs},
                      {"core:version", "1.0.0"},
                      {"core:hw", _hw},
                      {"core:recorder", "wsdr-studio"},
                      {"core:description", std::string("LA-mode baseband samples, path ") + (_path ? "B" : "A") +
                                               ", 12-bit values << 4, DC not removed; gain " +
                                               (_agc ? std::string("AGC") : std::to_string(_gain) + " dB (fixed)")}};
  if (final) {
    g["wsdr:samples"] = _bytes.load() / 4;
    if (_dropped && _error.empty())
      g["wsdr:note"] = "ended early: the disk could not keep up (the file has no gap)";
    if (!_error.empty())
      g["wsdr:error"] = _error;
  }
  const nlohmann::json meta = {
      {"global", g},
      {"captures", {{{"core:sample_start", 0}, {"core:frequency", _centre}, {"core:datetime", _datetime}}}},
      {"annotations", nlohmann::json::array()}};
  const std::string base = _base;
  l.unlock();
  // temp file + rename: a full disk leaves the previous meta file intact rather than a truncated one
  const std::string tmp = base + ".sigmf-meta.tmp";
  std::string err;
  {
    // write + fsync the temp file, rename it into place, fsync the directory: "Saved" means saved
    const std::string text = meta.dump(2) + "\n";
    const int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0 || ::write(fd, text.data(), text.size()) != static_cast<ssize_t>(text.size()) || ::fsync(fd) != 0)
      err = "writing the metadata file failed";
    if (fd >= 0 && ::close(fd) != 0 && err.empty())
      err = "writing the metadata file failed";
  }
  std::error_code ec;
  if (err.empty()) {
    std::filesystem::rename(tmp, base + ".sigmf-meta", ec);
    if (ec)
      err = "writing the metadata file failed: " + ec.message();
    const int dfd = ::open(std::filesystem::path(base).parent_path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dfd >= 0) {
      ::fsync(dfd);
      ::close(dfd);
    }
  } else {
    std::filesystem::remove(tmp, ec);
  }
  l.lock();
  _meta_error = err; // the latest metadata write decides (a later success clears an earlier failure)
}

RecordInfo Recorder::info() const {
  std::lock_guard<std::mutex> l(_m);
  RecordInfo i;
  i.active = _active;
  i.path = _base.empty() ? "" : _base + ".sigmf-data";
  i.samples = _bytes / 4;
  i.ended_early = _dropped > 0;
  i.fs = _fs;
  i.error = !_error.empty() ? _error : _meta_error;
  return i;
}

} // namespace studio
