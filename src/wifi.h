// SPDX-License-Identifier: GPL-2.0-only
// Wi-Fi frames in the raw I/Q: 802.11 OFDM preambles found by their 0.8 us repetition, each frame's
// 20 MHz channel, its legacy header (L-SIG: rate and length, so its airtime) and its format (legacy,
// HT, VHT). Receive only: this reads samples the adapter already captured.
#pragma once

#include <complex>
#include <cstdint>
#include <vector>

namespace wifi {

using cf = std::complex<float>;

struct Frame {
  double t = 0;          // start (s), on the clock of the samples fed in
  double centre_hz = 0;  // the 20 MHz channel it was decoded on (40 MHz: the pair's centre)
  int bw_mhz = 20;       // 20, or 40 when its preamble is duplicated on the paired channel (5 GHz)
  char fmt = 'L';        // 'L' legacy, 'H' HT (802.11n), 'V' VHT (802.11ac)
  int rate_mbps = 0;     // L-SIG rate (HT/VHT frames carry 6 here)
  int length = 0;        // L-SIG length (bytes)
  double dur_us = 0;     // airtime from L-SIG (covers the whole PPDU, also HT/VHT)
  float snr_db = 0;      // from the two LTF copies
};

class Decoder {
public:
  // fs: 20 or 40 MS/s (anything else finds nothing); centre_hz: the samples' centre frequency.
  void reset(double fs, double centre_hz);
  // Contiguous samples, in order; t_end: the time (s) just after the last one. Frames found are
  // appended to `out` (a frame is reported once its header has arrived).
  void feed(const cf *x, size_t n, double t_end, std::vector<Frame> &out);
  double fs() const { return _fs; }

  // One 20 MS/s snippet starting near a frame's short training field: decode its header (tests).
  static bool decode20(const cf *x, size_t n, Frame &f);

private:
  void scan(std::vector<Frame> &out);
  void frame_at(size_t pos, std::vector<Frame> &out);

  double _fs = 0, _centre = 0;
  int _lag = 0, _win = 0, _dec = 1;
  std::vector<cf> _buf;      // samples not yet scanned (plus what a frame's header needs)
  uint64_t _abs0 = 0;        // absolute index of _buf[0]
  uint64_t _scan = 0;        // next absolute index to examine
  uint64_t _abs_end = 0;     // absolute index after the last sample fed
  double _t_end = 0;         // its time
  bool _in = false;          // inside a plateau of the detector
  uint64_t _pstart = 0;      // where it started
  uint64_t _quiet_until = 0; // no new detection before this (the frame just found)
  double _noise = 0;         // running noise power per sample
  std::vector<float> _lp;    // channel filter (40 MS/s -> 20 MS/s)
  std::vector<double> _cands; // 20 MHz channel centres inside the span
};

} // namespace wifi
