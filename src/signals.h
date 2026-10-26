// SPDX-License-Identifier: GPL-2.0-only
// Signals other than Wi-Fi in the raw I/Q, tagged by cheap rules (after the Airshark idea): narrow
// bursts from a short-time spectrum (Bluetooth when they hop, else "narrowband"), and a microwave
// oven from the span's activity switching with the mains. Close enough to tag what the waterfall
// shows, not a decoder. Receive only.
#pragma once

#include <complex>
#include <cstdint>
#include <vector>

typedef struct fftwf_plan_s *fftwf_plan;

namespace sig {

using cf = std::complex<float>;

struct Burst {
  double t = 0;      // start (s), on the clock of the samples fed in
  double mhz = 0;    // centre
  double bw_mhz = 0; // width
  double dur_us = 0;
  char kind = 'N';   // 'T' Bluetooth (narrow bursts hopping), 'N' other narrowband, 'M' microwave oven
};

class Finder {
public:
  Finder() = default;
  Finder(const Finder &) = delete;
  Finder &operator=(const Finder &) = delete;
  ~Finder();
  // fs: 20 or 40 MS/s (anything else finds nothing); centre_hz: the samples' centre frequency.
  void reset(double fs, double centre_hz);
  // Contiguous samples, in order; t_end: the time (s) just after the last one. Bursts are appended to
  // `out` once they have ended (an oven once per 200 ms while it runs).
  void feed(const cf *x, size_t n, double t_end, std::vector<Burst> &out);

private:
  void release();
  void column(const cf *x, std::vector<Burst> &out);
  void end_track(size_t i, std::vector<Burst> &out);
  void oven(std::vector<Burst> &out); // every 200 ms
  double time_of(uint64_t sample) const { return _t_end - static_cast<double>(_abs_end - sample) / _fs; }
  double bin_hz(double k) const { return _centre + (k - 0.5 * _nf) * _fs / _nf; }

  double _fs = 0, _centre = 0, _t_end = 0;
  int _nf = 0, _hop = 0;             // FFT size (625 kHz bins), a column every _hop samples (6.4 us)
  uint64_t _abs_end = 0, _col = 0;   // samples fed; columns done (column c starts at sample c * _hop)
  std::vector<cf> _carry;            // samples from _carry_at on, not yet in a column
  uint64_t _carry_at = 0;
  std::vector<float> _win, _p, _floor; // window; this column's power; each bin's noise floor (20% quantile)
  fftwf_plan _plan = nullptr;
  cf *_in = nullptr, *_out = nullptr; // FFTW's buffers
  std::vector<uint8_t> _occ;

  struct Track {
    uint64_t c0, c1;                 // first and last column
    int a, b;                        // bins it covered
    double kw, w;                    // power-weighted bin sum, power sum (its centre)
  };
  std::vector<Track> _tracks;
  struct Seen { double t, mhz; };
  std::vector<Seen> _narrow;         // narrow bursts of the last 100 ms (hopping)

  // the oven: the span's activity per ms over 200 ms, and where the power was while loud
  float _tfloor = 0;
  std::vector<float> _busy;
  int _ms_cols = 0, _ms_loud = 0;
  double _win_t0 = 0;
  std::vector<float> _loudsum;
  bool _oven = false;                // the last 200 ms had an oven: its sweep is not narrowband
};

} // namespace sig
