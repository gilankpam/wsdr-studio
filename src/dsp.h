// SPDX-License-Identifier: GPL-2.0-only
// Spectrum DSP: LA banks -> per-path complex samples (unpack, DC block) -> windowed FFT (FFTW3f) -> rows
// for the display.
//
// The rows always cover the HARDWARE band (centre +- fs/2). The requested frequency may sit off the
// 5 MHz synthesizer grid; it is not shifted to the middle, because at 2.5/5 MS/s a residual of up to
// +-2.5 MHz would wrap the band around (the UI marks the requested frequency instead).
//
// Power is accumulated LINEAR per row interval (sum for the average, max for the peak trace) and
// converted to dB once per row. Above kMaxBins FFT bins, each display bin carries the summed power of
// the FFT bins it covers (noise in display units is then independent of the FFT size; a tone reads
// up to +1.8 dB high, the Hann leakage into the neighbour bin) and the max of their peaks.
// dBFS: a full-scale complex sine (|x| = 2048 LSB) reads 0 dBFS (coherent-gain normalised window).
#pragma once

#include <complex>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "iqdsp.h"
#include "receiver.h"

namespace studio {

constexpr int kMaxBins = 4096;

struct DspConfig {
  int fft = 8192;         // 1024 .. 16384, power of two
  double rows_per_s = 25; // display rows per second (1..30)
  int paths = 1;          // bit 0 = path A, bit 1 = path B (8812CU)
  bool dc_remove = true;
};

struct Row {
  int path = 0;           // 0 = A, 1 = B
  uint32_t seq = 0;
  uint8_t gen = 0;        // low byte of the stream run (BankMeta.gen): rows of a new run differ
  double f0 = 0, df = 0;  // Hz of bin 0 (lowest frequency) and bin spacing
  std::vector<float> avg, max; // dBFS, size bins
};

class Spectrum {
public:
  Spectrum();
  ~Spectrum();
  void configure(const DspConfig &c);
  // One raw LA bank. Resets state when meta.gen changes (new tuning / rate).
  void process(const uint8_t *bank, size_t bytes, const wsdr::BankMeta &meta,
               const std::function<void(const Row &)> &emit);
  uint64_t ffts() const { return _ffts; }

  // Unpack helpers (12-bit two's complement; path B lives in the upper word on the 8822C).
  static void unpack(const uint8_t *bank, size_t samples, int path, wsdr::cf *out);

private:
  struct Path;
  void reset(const wsdr::BankMeta &m);
  void rebuild();

  DspConfig _c;
  uint32_t _gen = ~0u;
  double _fs = 0, _freq = 0;
  std::vector<float> _win;
  float _norm = 1;
  std::vector<std::unique_ptr<Path>> _paths;
  uint64_t _ffts = 0;
  uint32_t _seq = 0;
  std::vector<wsdr::cf> _tmp;
};

} // namespace studio
