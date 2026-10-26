// SPDX-License-Identifier: GPL-2.0-only
#include "signals.h"

#include <fftw3.h>

#include "dsp.h"

#include <algorithm>
#include <cmath>

namespace sig {

namespace {
constexpr double kPi = 3.14159265358979323846;
constexpr int kNarrow = 4;      // bins (2.5 MHz) within 10 dB of a run's peak: wider is not narrowband
constexpr int kAround = 8;      // bins (5 MHz) either side that must stay 10 dB under it (not a shoulder)
constexpr uint64_t kWarm = 2000; // columns (~13 ms) before anything is reported: the floors settle
constexpr float kOcc = 45;      // occupied: 45x the bin's 20% quantile (~10 dB over its mean noise)
constexpr int kMsCols = 156;    // columns per "ms" (6.4 us each: 0.998 ms)
constexpr int kWinMs = 200;     // the oven is judged over 200 ms
} // namespace

Finder::~Finder() { release(); }

void Finder::release() {
  std::lock_guard<std::mutex> l(studio::fftw_plan_mutex());
  if (_plan)
    fftwf_destroy_plan(_plan);
  fftwf_free(_in);
  fftwf_free(_out);
  _plan = nullptr;
  _in = _out = nullptr;
}

void Finder::reset(double fs, double centre_hz) {
  release();
  _fs = fs;
  _centre = centre_hz;
  _nf = std::abs(fs - 40e6) < 1e3 ? 64 : std::abs(fs - 20e6) < 1e3 ? 32 : 0;
  _hop = 4 * _nf;
  _abs_end = _col = _next = _carry_at = 0;
  _carry.clear();
  _tracks.clear();
  _narrow.clear();
  _busy.clear();
  _ms_cols = _ms_loud = 0;
  _win_t0 = 0;
  _tfloor = 0;
  if (!_nf)
    return;
  _win.resize(_nf);
  for (int k = 0; k < _nf; k++)
    _win[k] = static_cast<float>(0.5 - 0.5 * std::cos(2 * kPi * k / _nf));
  {
    std::lock_guard<std::mutex> l(studio::fftw_plan_mutex());
    _in = reinterpret_cast<cf *>(fftwf_alloc_complex(static_cast<size_t>(_nf)));
    _out = reinterpret_cast<cf *>(fftwf_alloc_complex(static_cast<size_t>(_nf)));
    _plan = fftwf_plan_dft_1d(_nf, reinterpret_cast<fftwf_complex *>(_in), reinterpret_cast<fftwf_complex *>(_out), FFTW_FORWARD,
                              FFTW_ESTIMATE);
  }
  _p.assign(_nf, 0);
  _floor.assign(_nf, 0);
  _occ.assign(_nf, 0);
  _loudsum.assign(_nf, 0);
}

void Finder::feed(const cf *x, size_t n, double t_end, std::vector<Burst> &out) {
  if (!_nf)
    return;
  _carry.insert(_carry.end(), x, x + n);
  _abs_end += n;
  _t_end = t_end;
  while (_next + static_cast<uint64_t>(_nf) <= _carry_at + _carry.size()) {
    column(&_carry[_next - _carry_at], out);
    _next += static_cast<uint64_t>(_hop);
    _col++;
  }
  const uint64_t drop = std::min<uint64_t>(_next - _carry_at, _carry.size());
  _carry.erase(_carry.begin(), _carry.begin() + static_cast<long>(drop));
  _carry_at += drop;
}

void Finder::column(const cf *x, std::vector<Burst> &out) {
  // the spectrum, its power fftshifted
  for (int k = 0; k < _nf; k++)
    _in[k] = x[k] * _win[k];
  fftwf_execute(_plan);
  float total = 0;
  for (int k = 0; k < _nf; k++) {
    const float p = std::norm(_out[(k + _nf / 2) % _nf]);
    _p[k] = p;
    // each bin's floor: its 20% quantile over time (up 0.4% when above, down 1.6% when below)
    float &f = _floor[k];
    f = _col == 0 ? p : std::max(1e-30f, f * (p > f ? 1.004f : 0.984f));
    _occ[k] = k > 0 && k < _nf - 1 && p > kOcc * f; // (not the edge bins: the anti-alias filter)
    if (k > 0 && k < _nf - 1)
      total += p;
  }
  _tfloor = _col == 0 ? total : std::max(1e-30f, _tfloor * (total > _tfloor ? 1.004f : 0.984f));

  // the oven's evidence: is the span loud, and is what is loud narrow (a magnetron's wobbling
  // carrier, not a 20 MHz Wi-Fi frame)
  int occ = 0;
  for (int k = 0; k < _nf; k++)
    occ += _occ[k];
  if (total > 3 * _tfloor && occ <= 10) {
    _ms_loud++;
    for (int k = 0; k < _nf; k++)
      if (_occ[k])
        _loudsum[k] += _p[k];
  }
  if (_busy.empty() && _ms_cols == 0)
    _win_t0 = time_of(_next);
  if (++_ms_cols == kMsCols) {
    _busy.push_back(static_cast<float>(_ms_loud) / kMsCols);
    _ms_cols = _ms_loud = 0;
    if (static_cast<int>(_busy.size()) == kWinMs)
      oven(out);
  }

  // narrow runs: occupied bins whose core (within 10 dB of their peak) is at most kNarrow bins, with
  // nothing within kAround bins either side reaching that core (a strong Wi-Fi frame's shoulder is not
  // narrowband); measured from the run's own peak, so a strong burst's skirts do not widen it
  for (int a0 = 1; a0 < _nf - 1;) {
    if (!_occ[a0]) {
      a0++;
      continue;
    }
    int b0 = a0;
    while (b0 + 1 < _nf - 1 && _occ[b0 + 1])
      b0++;
    float pk = 0;
    for (int k = a0; k <= b0; k++)
      pk = std::max(pk, _p[k]);
    int a = b0, b = a0; // the core
    for (int k = a0; k <= b0; k++)
      if (_p[k] > 0.1f * pk) {
        a = std::min(a, k);
        b = std::max(b, k);
      }
    bool alone = true;
    for (int k = std::max(0, a0 - kAround); alone && k <= std::min(_nf - 1, b0 + kAround); k++)
      alone = (k >= a0 && k <= b0) || _p[k] <= 0.1f * pk;
    if (b - a + 1 <= kNarrow && b0 - a0 + 1 <= 3 * kNarrow && alone && _col >= kWarm) {
      size_t t = 0;
      while (t < _tracks.size() && !(_tracks[t].c1 + 2 >= _col && a <= _tracks[t].b + 1 && b >= _tracks[t].a - 1))
        t++;
      if (t == _tracks.size())
        _tracks.push_back({_col, _col, _next, a, b, 0, 0, 0, 0});
      Track &tr = _tracks[t];
      tr.c1 = _col;
      tr.a = std::min(tr.a, a);
      tr.b = std::max(tr.b, b);
      for (int k = a; k <= b; k++) {
        tr.kw += static_cast<double>(k) * _p[k];
        tr.w += _p[k];
        if (_p[k] > tr.peak) {
          tr.peak = _p[k];
          tr.fl = _floor[k];
        }
      }
    }
    a0 = b0 + 1;
  }
  for (size_t t = 0; t < _tracks.size();)
    if (_tracks[t].c1 + 2 < _col)
      end_track(t, out);
    else
      t++;
}

void Finder::end_track(size_t i, std::vector<Burst> &out) {
  const Track tr = _tracks[i];
  _tracks.erase(_tracks.begin() + static_cast<long>(i));
  const uint64_t cols = tr.c1 - tr.c0 + 1;
  if (cols < 3 || tr.b - tr.a + 1 > kNarrow || tr.w <= 0)
    return; // under ~20 us, or it grew wide
  Burst b;
  b.t = time_of(tr.s0);
  b.mhz = bin_hz(tr.kw / tr.w) / 1e6;
  b.bw_mhz = (tr.b - tr.a + 1) * _fs / _nf / 1e6;
  b.dur_us = static_cast<double>(cols * static_cast<uint64_t>(_hop)) / _fs * 1e6;
  b.snr_db = static_cast<float>(10 * std::log10(tr.peak / (tr.fl / 0.223f))); // (the 20% quantile of noise power is 0.223 of its mean)
  // Bluetooth hops: at 2.4 GHz, bursts of at most 3 ms, at least 4 within 100 ms on 3 frequencies
  b.kind = 'N';
  if (b.mhz > 2400 && b.mhz < 2484 && b.dur_us <= 3000) {
    _narrow.push_back({b.t, b.mhz});
    while (!_narrow.empty() && _narrow.front().t < b.t - 0.1)
      _narrow.erase(_narrow.begin());
    std::vector<long> f;
    for (const auto &s : _narrow)
      f.push_back(std::lround(s.mhz));
    std::sort(f.begin(), f.end());
    if (_narrow.size() >= 4 && std::unique(f.begin(), f.end()) - f.begin() >= 3)
      b.kind = 'T';
  }
  out.push_back(b);
}

// A microwave oven's magnetron runs on half-wave rectified mains: at 2.4 GHz the span is loud with a
// narrow, wobbling carrier for about half of every 20 ms (16.7 ms at 60 Hz) and quiet for the rest.
// The span's loud share per ms then repeats at the mains period and alternates at half of it.
void Finder::oven(std::vector<Burst> &out) {
  const int n = static_cast<int>(_busy.size());
  double mean = 0;
  for (float v : _busy)
    mean += v;
  mean /= n;
  const auto r = [&](int lag) { // autocorrelation, normalised
    double num = 0, den = 0;
    for (int m = 0; m < n; m++) {
      den += (_busy[m] - mean) * (_busy[m] - mean);
      if (m + lag < n)
        num += (_busy[m] - mean) * (_busy[m + lag] - mean);
    }
    return den > 0 ? num / den * n / (n - lag) : 0.0;
  };
  const bool band = _centre > 2.38e9 && _centre < 2.51e9;
  const bool hz50 = std::max({r(19), r(20), r(21)}) > 0.6 && std::min({r(9), r(10), r(11)}) < -0.3;
  const bool hz60 = std::max({r(16), r(17), r(18)}) > 0.6 && std::min({r(8), r(9)}) < -0.3;
  if (band && mean > 0.1 && mean < 0.9 && (hz50 || hz60)) {
    // where: the bins its loud columns occupied
    float mx = 0;
    for (float v : _loudsum)
      mx = std::max(mx, v);
    int a = _nf, b = -1;
    double kw = 0, w = 0;
    for (int k = 0; k < _nf; k++)
      if (mx > 0 && _loudsum[k] > 0.05f * mx) {
        a = std::min(a, k);
        b = std::max(b, k);
        kw += k * static_cast<double>(_loudsum[k]);
        w += _loudsum[k];
      }
    if (b >= a) {
      Burst o;
      o.t = _win_t0;
      o.mhz = bin_hz(kw / w) / 1e6;
      o.bw_mhz = (b - a + 1) * _fs / _nf / 1e6;
      o.dur_us = kWinMs * 1e3;
      o.kind = 'M';
      out.push_back(o);
    }
  }
  _busy.clear();
  std::fill(_loudsum.begin(), _loudsum.end(), 0.f);
}

} // namespace sig
