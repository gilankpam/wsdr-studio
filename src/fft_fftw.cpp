// SPDX-License-Identifier: GPL-2.0-only
// Fft on FFTW3f (the native build).
#include "fft.h"

#include <fftw3.h>

#include <mutex>

namespace studio {

namespace {
std::mutex g_fftw_plan_mutex; // FFTW planning is not thread-safe
} // namespace

struct Fft::Impl {
  fftwf_complex *in = nullptr, *out = nullptr;
  fftwf_plan plan = nullptr;
};

Fft::Fft(int n) : _n(n), _p(std::make_unique<Impl>()) {
  std::lock_guard<std::mutex> l(g_fftw_plan_mutex);
  _p->in = fftwf_alloc_complex(n);
  _p->out = fftwf_alloc_complex(n);
  _p->plan = fftwf_plan_dft_1d(n, _p->in, _p->out, FFTW_FORWARD, FFTW_ESTIMATE);
}

Fft::~Fft() {
  std::lock_guard<std::mutex> l(g_fftw_plan_mutex);
  fftwf_destroy_plan(_p->plan);
  fftwf_free(_p->in);
  fftwf_free(_p->out);
}

// fftwf_complex is float[2]: layout-compatible with std::complex<float>
std::complex<float> *Fft::in() { return reinterpret_cast<std::complex<float> *>(_p->in); }
const std::complex<float> *Fft::out() const { return reinterpret_cast<const std::complex<float> *>(_p->out); }
void Fft::run() { fftwf_execute(_p->plan); }

} // namespace studio
