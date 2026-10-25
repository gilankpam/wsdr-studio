// SPDX-License-Identifier: GPL-2.0-only
// IQ recorder: SigMF (ci16_le, the raw 12-bit samples << 4, at the hardware centre frequency) with its
// own writer thread. Files go only into the directory the server chose.
//
// Threading: start()/stop() are called from ONE thread (the engine's command thread); push() from the
// DSP thread; info()/failed() from any thread. A write error (disk full, I/O error) stops the writing
// and is reported through failed()/info().error; the engine then stops the recording.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace studio {

struct RecordInfo {
  bool active = false;
  std::string path;     // data file
  uint64_t samples = 0, dropped = 0;
  double fs = 0;
  std::string error;    // write failure, if any
};

class Recorder {
public:
  explicit Recorder(std::string dir) : _dir(std::move(dir)) {}
  ~Recorder() { stop(); }
  // Returns the data file path. Throws on I/O errors.
  std::string start(double fs, double centre_hz, const std::string &hw, int path, double gain_db, bool agc);
  bool stop(); // true if a recording was running (and is now finalised)
  // From the DSP thread: interleaved int16 I,Q.
  void push(const int16_t *iq, size_t samples);
  RecordInfo info() const;
  bool failed() const { return _failed; }
  uint64_t dropped() const { return _dropped; }
  const std::string &dir() const { return _dir; }

private:
  void writer();
  void write_meta(bool final);

  const std::string _dir;
  mutable std::mutex _m; // everything below except the atomics
  std::string _base, _hw, _datetime, _error;
  double _fs = 0, _centre = 0, _gain = 0;
  int _path = 0;
  bool _agc = false;
  std::condition_variable _cv;
  std::deque<std::vector<int16_t>> _q;
  size_t _queued = 0; // int16 values queued
  bool _quit = false;
  std::thread _t;
  int _fd = -1;
  std::atomic<bool> _active{false}, _failed{false};
  std::atomic<uint64_t> _samples{0}, _dropped{0};
};

} // namespace studio
