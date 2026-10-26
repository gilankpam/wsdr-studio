// SPDX-License-Identifier: GPL-2.0-only
#include "wifi.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace wifi {
namespace {

constexpr double kPi = 3.14159265358979323846;

// 802.11a constants. Subcarrier s (-26..26) sits in FFT bin (s + 64) % 64.
constexpr std::array<int, 53> kLtf = {1, 1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 0,
                                      1, -1, -1, 1, 1, -1, 1, -1, 1, -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1, 1};
constexpr std::array<int, 4> kPilotSc = {-21, -7, 7, 21};
constexpr std::array<int, 4> kPilotV = {1, 1, 1, -1};
constexpr std::array<int8_t, 127> kPol = {
    1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, -1, 1, 1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1, 1, 1, 1, 1, 1, -1, 1,
    1, 1, -1, 1, 1, -1, -1, 1, 1, 1, -1, 1, -1, -1, -1, 1, -1, 1, -1, -1, 1, -1, -1, 1, 1, 1, 1, 1, -1, -1, 1, 1,
    -1, -1, 1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, -1, -1, -1, 1, -1, -1, 1, -1, 1, 1, 1, 1, -1, 1, -1, 1, -1, 1,
    -1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1, 1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1};

int bin(int s) { return (s + 64) % 64; }

struct Tables {
  std::array<float, 64> ltf_f{};  // by FFT bin
  std::array<cf, 64> ltf_t{};     // its time-domain symbol
  std::array<int, 48> data_sc{};  // data subcarriers, in order
  std::array<int, 48> perm{};     // coded bit k was sent on data subcarrier perm[k] (BPSK)
  // Viterbi, K = 7, g0 = 133, g1 = 171 (octal): for each state its two predecessors, their input bit
  // and the expected outputs as +-1
  std::array<std::array<int, 2>, 64> prev{}, prevb{};
  std::array<std::array<std::array<float, 2>, 2>, 64> sgn{};
  Tables() {
    for (int i = 0; i < 53; i++)
      ltf_f[bin(i - 26)] = static_cast<float>(kLtf[i]);
    for (int n = 0; n < 64; n++) {
      cf acc = 0;
      for (int k = 0; k < 64; k++)
        acc += ltf_f[k] * std::polar(1.f, static_cast<float>(2 * kPi * k * n / 64));
      ltf_t[n] = acc / 64.f;
    }
    int j = 0;
    for (int s = -26; s <= 26; s++)
      if (s != 0 && s != -21 && s != -7 && s != 7 && s != 21)
        data_sc[j++] = s;
    for (int k = 0; k < 48; k++)
      perm[k] = 3 * (k % 16) + k / 16;
    std::array<int, 64> cnt{};
    for (int st = 0; st < 64; st++)
      for (int b = 0; b < 2; b++) {
        const int reg = (b << 6) | st;
        const int nx = reg >> 1;
        const int o0 = __builtin_parity(reg & 0133), o1 = __builtin_parity(reg & 0171);
        const int c = cnt[nx]++;
        prev[nx][c] = st;
        prevb[nx][c] = b;
        sgn[nx][c] = {2.f * o0 - 1, 2.f * o1 - 1};
      }
  }
};
const Tables &T() {
  static const Tables t;
  return t;
}

// In-place radix-2 FFT (n a power of two).
void fft(cf *a, int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1)
      j ^= bit;
    j ^= bit;
    if (i < j)
      std::swap(a[i], a[j]);
  }
  for (int len = 2; len <= n; len <<= 1) {
    const cf w = std::polar(1.f, static_cast<float>(-2 * kPi / len));
    for (int i = 0; i < n; i += len) {
      cf wn = 1;
      for (int k = 0; k < len / 2; k++) {
        const cf u = a[i + k], v = a[i + k + len / 2] * wn;
        a[i + k] = u + v;
        a[i + k + len / 2] = u - v;
        wn *= w;
      }
    }
  }
}

// Soft Viterbi (positive = bit 1): n output bits from 2n values.
std::vector<uint8_t> viterbi(const std::vector<float> &llr) {
  const Tables &t = T();
  const size_t n = llr.size() / 2;
  std::array<float, 64> pm, nm;
  pm.fill(-1e30f);
  pm[0] = 0;
  std::vector<std::array<uint8_t, 64>> dec(n);
  for (size_t i = 0; i < n; i++) {
    const float a = llr[2 * i], b = llr[2 * i + 1];
    for (int s = 0; s < 64; s++) {
      const float m0 = pm[t.prev[s][0]] + t.sgn[s][0][0] * a + t.sgn[s][0][1] * b;
      const float m1 = pm[t.prev[s][1]] + t.sgn[s][1][0] * a + t.sgn[s][1][1] * b;
      dec[i][s] = m1 > m0;
      nm[s] = std::max(m0, m1);
    }
    pm = nm;
  }
  // from the best end state (the tail bits should have brought it to 0: the caller checks them)
  int s = static_cast<int>(std::max_element(pm.begin(), pm.end()) - pm.begin());
  std::vector<uint8_t> bits(n);
  for (size_t i = n; i-- > 0;) {
    const int c = dec[i][s];
    bits[i] = static_cast<uint8_t>(t.prevb[s][c]);
    s = t.prev[s][c];
  }
  return bits;
}

// One 64-sample symbol: FFT, equalised by H, the pilots' phase (common and slope) removed.
std::array<cf, 64> symbol(const cf *x, const std::array<cf, 64> &h, int polarity) {
  std::array<cf, 64> z;
  std::copy(x, x + 64, z.begin());
  fft(z.data(), 64);
  for (int k = 0; k < 64; k++)
    z[k] /= h[k];
  float ph[4];
  for (int i = 0; i < 4; i++)
    ph[i] = std::arg(z[bin(kPilotSc[i])] * static_cast<float>(kPilotV[i] * polarity));
  for (int i = 1; i < 4; i++) { // unwrap along the subcarriers
    while (ph[i] - ph[i - 1] > kPi)
      ph[i] -= static_cast<float>(2 * kPi);
    while (ph[i] - ph[i - 1] < -kPi)
      ph[i] += static_cast<float>(2 * kPi);
  }
  float mean = 0, num = 0, den = 0;
  for (float p : ph)
    mean += p / 4;
  for (int i = 0; i < 4; i++) {
    num += kPilotSc[i] * (ph[i] - mean);
    den += static_cast<float>(kPilotSc[i] * kPilotSc[i]);
  }
  const float slope = num / den;
  for (int k = 0; k < 64; k++) {
    const int s = k >= 32 ? k - 64 : k;
    z[k] *= std::polar(1.f, -(mean + slope * s));
  }
  return z;
}

int rate_of(int code) {
  switch (code) {
  case 0b1101: return 6;
  case 0b1111: return 9;
  case 0b0101: return 12;
  case 0b0111: return 18;
  case 0b1001: return 24;
  case 0b1011: return 36;
  case 0b0001: return 48;
  case 0b0011: return 54;
  default: return 0;
  }
}

// Valid 20 MHz channel centres (Hz).
std::vector<double> channels() {
  std::vector<double> c;
  for (int k = 1; k <= 13; k++)
    c.push_back((2407 + 5 * k) * 1e6);
  c.push_back(2484e6);
  for (int n = 36; n <= 64; n += 4)
    c.push_back((5000 + 5 * n) * 1e6);
  for (int n = 100; n <= 144; n += 4)
    c.push_back((5000 + 5 * n) * 1e6);
  for (int n = 149; n <= 177; n += 4)
    c.push_back((5000 + 5 * n) * 1e6);
  return c;
}

// The other half of a 5 GHz 40 MHz channel (0 = none).
double partner(double c) {
  if (c < 5e9)
    return 0;
  const int n = static_cast<int>(std::lround((c - 5000e6) / 5e6));
  const int base = n >= 149 ? 149 : 36;
  const bool lower = ((n - base) / 4) % 2 == 0;
  return (5000 + 5 * (lower ? n + 4 : n - 4)) * 1e6;
}

} // namespace

bool Decoder::decode20(const cf *in, size_t n, Frame &f) {
  const Tables &t = T();
  if (n < 720)
    return false;
  std::vector<cf> x(in, in + n);
  // coarse frequency offset from the short training field (repeats every 16 samples)
  std::complex<double> c = 0;
  for (size_t k = 40; k < 136; k++)
    c += std::complex<double>(x[k]) * std::conj(std::complex<double>(x[k + 16]));
  double cfo = -std::arg(c) / (2 * kPi * 16); // cycles per sample
  for (size_t k = 0; k < n; k++)
    x[k] *= std::polar(1.f, static_cast<float>(-2 * kPi * cfo * static_cast<double>(k)));
  // the long training field: two copies 64 apart
  size_t l1 = 0;
  float best = -1;
  // (the snippet starts 2 us before the detector's plateau, which starts near the short training
  // field: the first LTF copy belongs ~232 samples in; a few us either way)
  for (size_t p = 150; p + 128 + 80 * 3 + 16 <= n && p < 330; p++) {
    float a = 0, b = 0;
    cf s1 = 0, s2 = 0;
    for (int k = 0; k < 64; k++) {
      s1 += x[p + k] * std::conj(t.ltf_t[k]);
      s2 += x[p + 64 + k] * std::conj(t.ltf_t[k]);
    }
    a = std::abs(s1);
    b = std::abs(s2);
    if (a + b > best) {
      best = a + b;
      l1 = p;
    }
  }
  if (l1 + 128 + 16 + 64 + 160 > n)
    return false;
  std::complex<double> d = 0;
  for (int k = 0; k < 64; k++)
    d += std::complex<double>(x[l1 + 64 + k]) * std::conj(std::complex<double>(x[l1 + k]));
  const double fine = std::arg(d) / (2 * kPi * 64);
  for (size_t k = 0; k < n; k++)
    x[k] *= std::polar(1.f, static_cast<float>(-2 * kPi * fine * static_cast<double>(k)));
  cfo += fine;
  std::array<cf, 64> f1, f2, h;
  std::copy(x.begin() + static_cast<long>(l1), x.begin() + static_cast<long>(l1 + 64), f1.begin());
  std::copy(x.begin() + static_cast<long>(l1 + 64), x.begin() + static_cast<long>(l1 + 128), f2.begin());
  fft(f1.data(), 64);
  fft(f2.data(), 64);
  double ps = 0, pn = 0;
  std::array<float, 64> nk{};
  for (int k = 0; k < 64; k++) {
    if (t.ltf_f[k] == 0) {
      h[k] = 1;
      continue;
    }
    h[k] = (f1[k] + f2[k]) / 2.f / t.ltf_f[k];
    ps += std::norm(f1[k] + f2[k]) / 4;
    pn += std::norm(f1[k] - f2[k]) / 4;
    nk[k] = std::norm(f1[k] - f2[k]) / 2 / (std::norm(h[k]) + 1e-20f);
  }
  f.snr_db = static_cast<float>(10 * std::log10(ps / (pn + 1e-20)));
  // per-subcarrier noise, smoothed over 5 neighbours: a narrow interferer counts less in the decode
  std::array<float, 64> w{};
  for (int k = 0; k < 64; k++) {
    float s = 0;
    int m = 0;
    for (int j = -2; j <= 2; j++)
      if (t.ltf_f[(k + j + 64) % 64] != 0) { // (DC and the guard bins carry no noise estimate)
        s += nk[(k + j + 64) % 64];
        m++;
      }
    w[k] = m ? s / static_cast<float>(m) : 0;
  }
  std::array<float, 48> wd;
  for (int i = 0; i < 48; i++)
    wd[i] = w[bin(t.data_sc[i])];
  std::array<float, 48> tmp = wd;
  std::nth_element(tmp.begin(), tmp.begin() + 24, tmp.end());
  const float floor = tmp[24] * 0.5f + 1e-20f;
  const size_t sig0 = l1 + 128 + 16;
  const auto zs = symbol(&x[sig0], h, kPol[0]);
  std::array<float, 48> soft;
  float norm = 0;
  for (int i = 0; i < 48; i++) {
    soft[i] = zs[bin(t.data_sc[i])].real() / (wd[i] + floor);
    norm += std::abs(soft[i]) / 48;
  }
  std::vector<float> llr(48);
  for (int k = 0; k < 48; k++)
    llr[k] = soft[t.perm[k]] / (norm + 1e-20f);
  const auto b = viterbi(llr);
  int parity = 0;
  for (int i = 0; i < 18; i++)
    parity ^= b[i];
  const int code = (b[0] << 3) | (b[1] << 2) | (b[2] << 1) | b[3];
  int len = 0;
  for (int i = 0; i < 12; i++)
    len |= b[5 + i] << i;
  bool tail0 = true;
  for (int i = 18; i < 24; i++)
    tail0 = tail0 && !b[i];
  const int rate = rate_of(code);
  if (parity || !rate || b[4] || !tail0 || len == 0)
    return false;
  f.rate_mbps = rate;
  f.length = len;
  f.dur_us = 20 + 4 * std::ceil((16 + 8.0 * len + 6) / (4.0 * rate));
  if (f.dur_us > 5484) // longer than any PPDU may be
    return false;
  f.t = (static_cast<double>(l1) - 232) / 20e6; // the frame's start relative to where it was looked for
  // HT-SIG: two QBPSK symbols; VHT-SIG-A: BPSK then QBPSK (both only after a 6 Mb/s L-SIG)
  f.fmt = 'L';
  if (rate == 6) {
    auto q = [&](size_t at, int pol) {
      const auto z = symbol(&x[at], h, pol);
      float re = 0, im = 0;
      for (int s : t.data_sc) {
        re += std::abs(z[bin(s)].real());
        im += std::abs(z[bin(s)].imag());
      }
      return im > re;
    };
    const bool q1 = q(sig0 + 80, kPol[1]), q2 = q(sig0 + 160, kPol[2]);
    f.fmt = q1 ? 'H' : q2 ? 'V' : 'L';
  }
  (void)cfo;
  return true;
}

void Decoder::reset(double fs, double centre_hz) {
  _fs = fs;
  _centre = centre_hz;
  _dec = std::abs(fs - 40e6) < 1e3 ? 2 : std::abs(fs - 20e6) < 1e3 ? 1 : 0;
  _lag = 16 * _dec;
  _win = 48 * _dec;
  _buf.clear();
  _abs0 = _scan = _abs_end = 0;
  _in = false;
  _pstart = _quiet_until = 0;
  _noise = 0;
  _lvl.assign(std::max<size_t>(64, static_cast<size_t>(0.1 * fs / 256)), 0.f);
  _lvl_at = _lvl_n = 0;
  _lvl_scans = 0;
  _cands.clear();
  for (double c : channels())
    if (_dec && std::abs(c - centre_hz) <= (_dec == 2 ? 11.5e6 : 1.5e6))
      _cands.push_back(c);
  _lp.clear();
  if (_dec == 2) { // 41 taps, cut at 9.6 MHz of 40 MS/s, Hamming
    const int nt = 41;
    double sum = 0;
    for (int i = 0; i < nt; i++) {
      const double m = i - (nt - 1) / 2.0;
      const double sinc = m == 0 ? 2 * 9.6e6 / 40e6 : std::sin(2 * kPi * 9.6e6 / 40e6 * m) / (kPi * m);
      const double win = 0.54 - 0.46 * std::cos(2 * kPi * i / (nt - 1));
      _lp.push_back(static_cast<float>(sinc * win));
      sum += sinc * win;
    }
    for (float &v : _lp)
      v = static_cast<float>(v / sum);
  }
}

void Decoder::feed(const cf *x, size_t n, double t_end, std::vector<Frame> &out) {
  if (!_dec || _cands.empty())
    return;
  _buf.insert(_buf.end(), x, x + n);
  _abs_end += n;
  _t_end = t_end;
  scan(out);
}

void Decoder::scan(std::vector<Frame> &out) {
  const uint64_t pre = 40 * static_cast<uint64_t>(_dec);
  const uint64_t need = 900 * static_cast<uint64_t>(_dec) + _lp.size();
  const uint64_t W = static_cast<uint64_t>(_win), L = static_cast<uint64_t>(_lag);
  if (_abs_end < _scan + W + L + need + 1)
    return;
  const uint64_t limit = _abs_end - W - L - need;
  const auto at = [&](uint64_t a) { return _buf[a - _abs0]; };
  // window sums at _scan, then slid one sample at a time
  std::complex<double> c = 0;
  double p1 = 0, p2 = 0;
  for (uint64_t k = _scan; k < _scan + W; k++) {
    c += std::complex<double>(at(k)) * std::conj(std::complex<double>(at(k + L)));
    p1 += std::norm(at(k));
    p2 += std::norm(at(k + L));
  }
  const uint64_t min_plateau = 50 * static_cast<uint64_t>(_dec), max_plateau = 400 * static_cast<uint64_t>(_dec);
  for (uint64_t i = _scan; i < limit; i++) {
    if ((i & 255) == 0) {
      _lvl[_lvl_at] = static_cast<float>(p2 / static_cast<double>(W));
      _lvl_at = (_lvl_at + 1) % _lvl.size();
      _lvl_n = std::min(_lvl_n + 1, _lvl.size());
    }
    const double m = std::norm(c) / (p1 * p2 + 1e-30);
    const bool on = m > 0.5 && _noise > 0 && p2 / static_cast<double>(W) > 2 * _noise && i >= _quiet_until;
    if (on && !_in) {
      _in = true;
      _pstart = i;
    } else if (_in && (!on || i - _pstart > max_plateau)) {
      _in = false;
      if (on) { // a plateau that never ends is no Wi-Fi preamble (a steady periodic signal)
        _quiet_until = i + max_plateau;
      } else if (i - _pstart >= min_plateau) {
        frame_at(_pstart, out);
        // past its L-SIG (a later plateau inside the same preamble is not another frame)
        _quiet_until = std::max(i + 200 * static_cast<uint64_t>(_dec), _pstart + 520 * static_cast<uint64_t>(_dec));
      }
    }
    // slide
    const cf a0 = at(i), aL = at(i + L), b0 = at(i + W), bL = at(i + W + L);
    c += std::complex<double>(b0) * std::conj(std::complex<double>(bL)) -
         std::complex<double>(a0) * std::conj(std::complex<double>(aL));
    p1 += std::norm(b0) - std::norm(a0);
    p2 += std::norm(bL) - std::norm(aL);
  }
  _scan = limit;
  // the noise floor: a low quantile of the window power over the last ~100 ms (a long frame, an
  // A-MPDU of a few ms, must not become the floor), every 16 scans (~3 ms)
  if (_lvl_n >= 16 && ++_lvl_scans % 16 == 1) {
    _lvl_tmp.assign(_lvl.begin(), _lvl.begin() + static_cast<long>(_lvl_n));
    std::nth_element(_lvl_tmp.begin(), _lvl_tmp.begin() + static_cast<long>(_lvl_n / 10), _lvl_tmp.end());
    _noise = _lvl_tmp[_lvl_n / 10];
  }
  // keep what a frame found later still needs
  const uint64_t from = _in ? std::min(_pstart, _scan) : _scan;
  const uint64_t keep = from > pre ? from - pre : 0;
  if (keep > _abs0) {
    _buf.erase(_buf.begin(), _buf.begin() + static_cast<long>(keep - _abs0));
    _abs0 = keep;
  }
}

void Decoder::frame_at(uint64_t pos_abs, std::vector<Frame> &out) {
  const Tables &t = T();
  const uint64_t pos = pos_abs;
  const uint64_t pre = 40 * static_cast<uint64_t>(_dec);
  const uint64_t len = 900 * static_cast<uint64_t>(_dec) + _lp.size();
  if (pos < _abs0 + pre || pos - pre + len > _abs_end)
    return;
  const cf *s = &_buf[pos - pre - _abs0];
  // which 20 MHz channel: in-band power against the edges just outside, over the training fields
  double c = _cands.front(), pin_best = 0;
  bool forty = false;
  if (_dec == 2) {
    std::array<cf, 256> z;
    std::copy(s + pre + 340, s + pre + 340 + 256, z.begin());
    fft(z.data(), 256);
    std::array<double, 256> p;
    for (int k = 0; k < 256; k++)
      p[k] = std::norm(z[(k + 128) % 256]); // fftshift: p[k] at (k - 128) * fs / 256
    const double df = _fs / 256;
    auto band = [&](double off, double lo, double hi) {
      double sum = 0;
      int n = 0;
      for (int k = 0; k < 256; k++) {
        const double f = (k - 128) * df, d = std::abs(f - off);
        if (d >= lo && d <= hi && std::abs(f) < _fs / 2 - 0.5e6) {
          sum += p[k];
          n++;
        }
      }
      return n ? sum / n : -1.0;
    };
    std::vector<double> sorted(p.begin(), p.end());
    std::nth_element(sorted.begin(), sorted.begin() + 64, sorted.end());
    const double floor = sorted[64] + 1e-30;
    double best = -1;
    for (double cand : _cands) {
      const double off = cand - _centre;
      const double in = band(off, 0.6e6, 8.1e6), o = band(off, 8.9e6, 10.6e6);
      const double score = in / ((o > 0 ? o : floor) + floor * 0.1);
      if (score > best) {
        best = score;
        c = cand;
        pin_best = in;
      }
    }
    const double pr = partner(c);
    if (pr && std::find(_cands.begin(), _cands.end(), pr) != _cands.end() && band(pr - _centre, 0.6e6, 8.1e6) > 0.5 * pin_best)
      forty = true;
  } else {
    double bd = 1e18;
    for (double cand : _cands)
      if (std::abs(cand - _centre) < bd) {
        bd = std::abs(cand - _centre);
        c = cand;
      }
  }
  // to 20 MS/s on that channel
  const double off = c - _centre;
  std::vector<cf> y(len);
  for (uint64_t k = 0; k < len; k++)
    y[k] = s[k] * std::polar(1.f, static_cast<float>(-2 * kPi * off / _fs * static_cast<double>(k)));
  std::vector<cf> z20;
  if (_dec == 2) {
    const size_t nt = _lp.size();
    for (size_t m = 0; 2 * m + nt <= len; m++) {
      cf acc = 0;
      for (size_t k = 0; k < nt; k++)
        acc += y[2 * m + k] * _lp[k];
      z20.push_back(acc);
    }
  } else {
    z20 = std::move(y);
  }
  Frame f;
  if (!decode20(z20.data(), z20.size(), f))
    return;
  f.t += _t_end - static_cast<double>(_abs_end - pos) / _fs; // (decode20 left the offset from pos)
  f.bw_mhz = forty ? 40 : 20;
  f.centre_hz = forty ? (c + partner(c)) / 2 : c;
  out.push_back(f);
  (void)t;
}

} // namespace wifi
