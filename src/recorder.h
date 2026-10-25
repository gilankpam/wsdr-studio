// SPDX-License-Identifier: GPL-2.0-only
// IQ recorder: SigMF (ci16_le, the raw 12-bit samples << 4, at the hardware centre frequency) with its
// own writer thread. Files go only into the directory the server chose. A settings change (retune,
// rate) ends the recording, so every file has one centre frequency and one rate.
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
  double fs = 0, centre_hz = 0;
};

class Recorder {
public:
  explicit Recorder(std::string dir) : _dir(std::move(dir)) {}
  ~Recorder() { stop(); }
  // Returns the data file path. Throws on I/O errors.
  std::string start(double fs, double centre_hz, const std::string &hw, int path, double gain_db, bool agc);
  void stop();
  // From the DSP thread: interleaved int16 I,Q.
  void push(const int16_t *iq, size_t samples);
  RecordInfo info() const;
  bool active() const { return _active; }
  const std::string &dir() const { return _dir; }

private:
  void writer();
  void write_meta(bool final);

  std::string _dir, _base, _hw, _datetime;
  double _fs = 0, _centre = 0, _gain = 0;
  int _path = 0;
  bool _agc = false;
  std::atomic<bool> _active{false};
  std::atomic<uint64_t> _samples{0}, _dropped{0};
  mutable std::mutex _m;
  std::condition_variable _cv;
  std::deque<std::vector<int16_t>> _q;
  size_t _queued = 0; // int16 values queued
  bool _quit = false;
  std::thread _t;
  int _fd = -1;
};

} // namespace studio
