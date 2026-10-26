// SPDX-License-Identifier: GPL-2.0-only
// Fft on pocketfft (the web build: no FFTW in WebAssembly). Vendored in external/pocketfft:
//   mreineck/pocketfft branch cpp, commit 4d865cba24359b05b37da4e75aee24498c3b78e7 (2026-10-18)
//   pocketfft_hdronly.h sha256 518a95c552aeaee352aa30122137cd9e135d23c91e2863d9272aaa758744c86d
//   LICENSE.md          sha256 a85ca13fdf90160b64a0698215868c13b74d835ad0a4e2ba44713b8c5058a056 (BSD-3-Clause)
#include "fft.h"

#define POCKETFFT_NO_MULTITHREADING // the engine's threads are the parallelism; no pool of its own
#include "pocketfft_hdronly.h"

#include <algorithm>
#include <vector>

namespace studio {

struct Fft::Impl {
  explicit Impl(int n) : plan(static_cast<size_t>(n)), in(n), out(n) {}
  pocketfft::detail::pocketfft_c<float> plan;
  std::vector<std::complex<float>> in, out;
};

Fft::Fft(int n) : _n(n), _p(std::make_unique<Impl>(n)) {}
Fft::~Fft() = default;

std::complex<float> *Fft::in() { return _p->in.data(); }
const std::complex<float> *Fft::out() const { return _p->out.data(); }

void Fft::run() {
  std::copy(_p->in.begin(), _p->in.end(), _p->out.begin());
  // cmplx<float> is two floats, like std::complex<float>
  _p->plan.exec(reinterpret_cast<pocketfft::detail::cmplx<float> *>(_p->out.data()), 1.f, true);
}

} // namespace studio
