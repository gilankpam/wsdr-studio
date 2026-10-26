// SPDX-License-Identifier: GPL-2.0-only
// One forward complex FFT of a fixed size: fill in(), run(), read out() (unnormalised). Two backends,
// one per build: FFTW (fft_fftw.cpp, native) and pocketfft (fft_pocketfft.cpp, the web build).
#pragma once

#include <complex>
#include <memory>

namespace studio {

class Fft {
public:
  explicit Fft(int n);
  ~Fft();
  Fft(const Fft &) = delete;
  Fft &operator=(const Fft &) = delete;

  std::complex<float> *in();
  const std::complex<float> *out() const;
  void run();
  int size() const { return _n; }

private:
  struct Impl;
  int _n;
  std::unique_ptr<Impl> _p;
};

} // namespace studio
