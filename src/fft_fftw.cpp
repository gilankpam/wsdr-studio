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
  bool measured = false; // plan from wisdom (else an estimate)

  void replan(int n) { // (the plan mutex held)
    if (plan)
      fftwf_destroy_plan(plan);
    plan = fftwf_plan_dft_1d(n, in, out, FFTW_FORWARD, FFTW_MEASURE | FFTW_WISDOM_ONLY);
    measured = plan != nullptr;
    if (!plan)
      plan = fftwf_plan_dft_1d(n, in, out, FFTW_FORWARD, FFTW_ESTIMATE);
  }
};

Fft::Fft(int n) : _n(n), _p(std::make_unique<Impl>()) {
  std::lock_guard<std::mutex> l(g_fftw_plan_mutex);
  _p->in = fftwf_alloc_complex(n);
  _p->out = fftwf_alloc_complex(n);
  _p->replan(n);
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

bool Fft::measured() const { return _p->measured; }

void Fft::replan() {
  std::lock_guard<std::mutex> l(g_fftw_plan_mutex);
  _p->replan(_n);
}

void Fft::warm(int n) {
  std::lock_guard<std::mutex> l(g_fftw_plan_mutex);
  fftwf_complex *in = fftwf_alloc_complex(n), *out = fftwf_alloc_complex(n);
  if (fftwf_plan p = fftwf_plan_dft_1d(n, in, out, FFTW_FORWARD, FFTW_MEASURE))
    fftwf_destroy_plan(p); // (its wisdom stays with the process)
  fftwf_free(in);
  fftwf_free(out);
}

} // namespace studio
