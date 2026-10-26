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

// x[k] *= exp(j 2 pi cycles k): a phasor stepped per sample (renormalised every 1024, in double)
void rotate(cf *x, size_t n, double cycles) {
  const std::complex<double> step = std::polar(1.0, 2 * kPi * cycles);
  std::complex<double> ph = 1;
  for (size_t k = 0; k < n; k++) {
    x[k] *= std::complex<float>(ph);
    ph *= step;
    if ((k & 1023) == 1023)
      ph /= std::abs(ph);
  }
}

uint32_t crc32(const uint8_t *p, size_t n) {
  static const auto table = [] {
    std::array<uint32_t, 256> t{};
    for (uint32_t i = 0; i < 256; i++) {
      uint32_t c = i;
      for (int k = 0; k < 8; k++)
        c = c & 1 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
      t[i] = c;
    }
    return t;
  }();
  uint32_t c = 0xFFFFFFFFu;
  for (size_t i = 0; i < n; i++)
    c = table[(c ^ p[i]) & 0xff] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

// A network name as text: strict UTF-8 (no overlongs, surrogates or code points past U+10FFFF: the
// JSON writer refuses them) without control characters or bidirectional overrides (a name must not
// disguise itself); anything else shows as '?'. All zero bytes (a hidden network) gives "".
std::string utf8(const uint8_t *p, size_t n);
} // namespace
std::string ssid_text(const uint8_t *p, size_t n) { return utf8(p, n); }
namespace {
std::string utf8(const uint8_t *p, size_t n) {
  bool zero = true;
  for (size_t i = 0; i < n; i++)
    zero = zero && p[i] == 0;
  std::string s;
  if (zero)
    return s;
  while (n > 0 && p[n - 1] == 0) // padding
    n--;
  for (size_t i = 0; i < n;) {
    const uint8_t c = p[i];
    size_t k = 0;
    uint32_t cp = 0;
    uint8_t lo = 0x80, hi = 0xBF; // the second byte's range
    if (c < 0x80) {
      k = 1;
      cp = c;
    } else if (c >= 0xC2 && c <= 0xDF) {
      k = 2;
      cp = c & 0x1F;
    } else if (c >= 0xE0 && c <= 0xEF) {
      k = 3;
      cp = c & 0x0F;
      if (c == 0xE0) lo = 0xA0;
      if (c == 0xED) hi = 0x9F; // no surrogates
    } else if (c >= 0xF0 && c <= 0xF4) {
      k = 4;
      cp = c & 0x07;
      if (c == 0xF0) lo = 0x90;
      if (c == 0xF4) hi = 0x8F; // up to U+10FFFF
    }
    bool ok = k > 0 && i + k <= n;
    for (size_t j = 1; ok && j < k; j++) {
      const uint8_t b = p[i + j];
      ok = j == 1 ? b >= lo && b <= hi : (b & 0xC0) == 0x80;
      cp = (cp << 6) | (b & 0x3F);
    }
    if (ok && (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F) || cp == 0xAD || cp == 0x61C || (cp >= 0x200B && cp <= 0x200F) ||
               (cp >= 0x2028 && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069) || cp == 0xFEFF || (cp >= 0xE0000 && cp <= 0xE007F)))
      ok = false; // control characters, invisible and bidirectional marks, tag characters
    if (ok) {
      s.append(reinterpret_cast<const char *>(p + i), k);
      i += k;
    } else {
      s += '?';
      i++;
    }
  }
  return s;
}

// A MAC frame whose FCS was good: its type, sender and, for beacons and probe responses, the network
// (BSSID, name, primary channel). Nothing else is read.
void parse_mac(const std::vector<uint8_t> &by, Frame &f) {
  if ((by[0] & 3) != 0 || ((by[0] >> 2) & 3) == 3)
    return; // not protocol version 0, or a reserved type: no header to read
  f.mac = true;
  f.type = (by[0] >> 2) & 3;
  f.subtype = by[0] >> 4;
  // CTS and ACK carry no sender; a control wrapper (7) another layout
  const bool no_ta = f.type == 1 && (f.subtype == 12 || f.subtype == 13 || f.subtype == 7);
  if (!no_ta && by.size() >= 20) {
    f.has_ta = true;
    std::copy(by.begin() + 10, by.begin() + 16, f.ta.begin());
  }
  if (f.type == 0 && (f.subtype == 8 || f.subtype == 5) && by.size() >= 40) { // beacon, probe response
    f.beacon = true;
    std::copy(by.begin() + 16, by.begin() + 22, f.bssid.begin());
    for (size_t p = 36; p + 2 <= by.size() - 4;) { // the information elements
      const uint8_t id = by[p], l = by[p + 1];
      if (p + 2 + l > by.size() - 4)
        break;
      if (id == 0)
        f.ssid = utf8(&by[p + 2], l);
      else if (id == 3 && l == 1) // DS parameter set (2.4 GHz)
        f.channel = by[p + 2];
      else if (id == 61 && l >= 1 && !f.channel) // HT operation: its primary channel (5 GHz beacons)
        f.channel = by[p + 2];
      p += 2 + l;
    }
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

bool Decoder::decode20(const cf *in, size_t n, Frame &f, bool payload) {
  const Tables &t = T();
  if (n < 720)
    return false;
  std::vector<cf> x(in, in + n);
  // coarse frequency offset from the short training field (repeats every 16 samples)
  std::complex<double> c = 0;
  for (size_t k = 40; k < 136; k++)
    c += std::complex<double>(x[k]) * std::conj(std::complex<double>(x[k + 16]));
  double cfo = -std::arg(c) / (2 * kPi * 16); // cycles per sample
  rotate(x.data(), n, -cfo);
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
  rotate(x.data(), n, -fine);
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
  const int nsym = static_cast<int>(std::ceil((16 + 8.0 * len + 6) / 24));
  if (!payload || rate != 6 || f.fmt != 'L' || len < 14 || sig0 + 80 * static_cast<size_t>(nsym + 1) > n)
    return true;
  // the data symbols, BPSK; each subcarrier's noise from the quadrature part over the whole frame (it
  // should be 0): one that is hit (a fade, the sender's own artefacts) counts less
  std::vector<std::array<cf, 48>> ds(nsym);
  std::array<double, 48> var{};
  for (int i = 0; i < nsym; i++) {
    const auto z = symbol(&x[sig0 + 80 * static_cast<size_t>(i + 1)], h, kPol[(i + 1) % 127]);
    for (int k = 0; k < 48; k++) {
      ds[i][k] = z[bin(t.data_sc[k])];
      var[k] += ds[i][k].imag() * ds[i][k].imag();
    }
  }
  std::vector<float> pl(48 * static_cast<size_t>(nsym));
  for (int i = 0; i < nsym; i++)
    for (int k = 0; k < 48; k++)
      pl[48 * static_cast<size_t>(i) + k] = ds[i][t.perm[k]].real() / static_cast<float>(var[t.perm[k]] / nsym + 0.02);
  auto bits = viterbi(pl);
  // descramble: the first 7 bits of SERVICE are zero before scrambling, so they are the scrambler's
  // state (x^7 + x^4 + 1)
  unsigned reg = 0;
  for (int i = 0; i < 7; i++)
    reg = ((reg << 1) | bits[i]) & 0x7f;
  for (size_t i = 7; i < bits.size(); i++) {
    const unsigned fb = ((reg >> 6) ^ (reg >> 3)) & 1;
    bits[i] ^= static_cast<uint8_t>(fb);
    reg = ((reg << 1) | fb) & 0x7f;
  }
  std::vector<uint8_t> by(static_cast<size_t>(len));
  for (int b = 0; b < len; b++) {
    uint8_t v = 0;
    for (int j = 0; j < 8; j++)
      v |= static_cast<uint8_t>(bits[16 + 8 * static_cast<size_t>(b) + j] << j);
    by[b] = v;
  }
  if (crc32(by.data(), by.size() - 4) != (by[len - 4] | by[len - 3] << 8 | by[len - 2] << 16 | static_cast<uint32_t>(by[len - 1]) << 24))
    return true; // the header stands; the rest was not received cleanly
  parse_mac(by, f);
  return true;
}

void Decoder::reset(double fs, double centre_hz) {
  _fs = fs;
  _centre = centre_hz;
  _dec = std::abs(fs - 40e6) < 1e3 ? 2 : std::abs(fs - 20e6) < 1e3 ? 1 : 0;
  _lag = 16 * _dec;
  _win = 48 * _dec;
  _buf.clear();
  _pend.clear();
  _bjobs.clear();
  _bin = false;
  _dsss = centre_hz < 3e9;
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
      const double lv = p2 / static_cast<double>(W);
      _lvl[_lvl_at] = static_cast<float>(lv);
      _lvl_at = (_lvl_at + 1) % _lvl.size();
      _lvl_n = std::min(_lvl_n + 1, _lvl.size());
      if (_dsss && _noise > 0) { // a burst: 6 dB over the floor, up to 6 ms
        const bool busy = lv > 4 * _noise;
        const uint64_t us = static_cast<uint64_t>(_fs / 1e6);
        if (busy && !_bin) {
          _bin = true;
          _bstart = i;
        } else if (_bin && (!busy || i - _bstart > 6000 * us)) {
          _bin = false;
          if (i - _bstart >= 200 * us)
            _bjobs.emplace_back(_bstart > _abs0 + 10 * us ? _bstart - 10 * us : _abs0, i + 10 * us);
        }
      }
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
  finish(out);
  // the noise floor: a low quantile of the window power over the last ~100 ms (a long frame, an
  // A-MPDU of a few ms, must not become the floor), every 16 scans (~3 ms)
  if (_lvl_n >= 16 && ++_lvl_scans % 16 == 1) {
    _lvl_tmp.assign(_lvl.begin(), _lvl.begin() + static_cast<long>(_lvl_n));
    std::nth_element(_lvl_tmp.begin(), _lvl_tmp.begin() + static_cast<long>(_lvl_n / 10), _lvl_tmp.end());
    _noise = _lvl_tmp[_lvl_n / 10];
  }
  // keep what a frame found later still needs
  uint64_t from = _in ? std::min(_pstart, _scan) : _scan;
  for (const auto &p : _pend) // a frame still arriving keeps its samples
    from = std::min(from, p.pos + pre);
  if (_bin) // a burst still going on, and ended ones not yet decoded
    from = std::min(from, _bstart);
  for (const auto &b : _bjobs)
    from = std::min(from, b.first + pre);
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
  const double off = c - _centre;
  const auto z20 = snippet(pos - pre, len, off);
  Frame f;
  if (!decode20(z20.data(), z20.size(), f))
    return;
  // (decode20 left the offset from pos; at 40 MS/s the 41-tap filter delays the snippet by 10 samples
  // of 20 MS/s)
  f.t += _t_end - static_cast<double>(_abs_end - pos) / _fs + (_dec == 2 ? 10 / 20e6 : 0);
  f.bw_mhz = forty ? 40 : 20;
  f.centre_hz = forty ? (c + partner(c)) / 2 : c;
  // a 6 Mb/s legacy frame (beacons, ACKs, RTS/CTS ...): decoded whole once all of it has arrived
  if (f.rate_mbps == 6 && f.fmt == 'L' && f.length >= 14 && f.length <= 800) {
    const uint64_t nsym = static_cast<uint64_t>(std::ceil((16 + 8.0 * f.length + 6) / 24));
    const uint64_t n20 = 330 + 144 + 80 * (nsym + 1) + 16; // (the LTF may sit up to sample 330)
    _pend.push_back({pos - pre, pos - pre + n20 * static_cast<uint64_t>(_dec) + _lp.size(), off, f});
    return;
  }
  out.push_back(f);
  (void)t;
}

std::vector<cf> Decoder::snippet(uint64_t from, uint64_t len, double off) const {
  const cf *s = &_buf[from - _abs0];
  std::vector<cf> y(s, s + len);
  rotate(y.data(), len, -off / _fs);
  if (_dec != 2)
    return y;
  std::vector<cf> z20;
  const size_t nt = _lp.size();
  z20.reserve(len / 2);
  for (size_t m = 0; 2 * m + nt <= len; m++) {
    cf acc = 0;
    for (size_t k = 0; k < nt; k++)
      acc += y[2 * m + k] * _lp[k];
    z20.push_back(acc);
  }
  return z20;
}

void Decoder::finish(std::vector<Frame> &out) {
  for (size_t i = 0; i < _bjobs.size();) {
    if (_bjobs[i].second + _lp.size() > _abs_end) {
      i++;
      continue;
    }
    dsss_at(_bjobs[i].first, _bjobs[i].second, out);
    _bjobs.erase(_bjobs.begin() + static_cast<long>(i));
  }
  for (size_t i = 0; i < _pend.size();) {
    auto &p = _pend[i];
    if (p.end > _abs_end) {
      i++;
      continue;
    }
    const auto z20 = snippet(p.pos, p.end - p.pos, p.off);
    Frame g;
    if (decode20(z20.data(), z20.size(), g, true) && g.mac) {
      Frame &f = p.f; // its timing and channel stay; the MAC fields come from the whole decode
      f.mac = true;
      f.type = g.type;
      f.subtype = g.subtype;
      f.has_ta = g.has_ta;
      f.ta = g.ta;
      f.beacon = g.beacon;
      f.bssid = g.bssid;
      f.ssid = g.ssid;
      f.channel = g.channel;
    }
    out.push_back(p.f);
    _pend.erase(_pend.begin() + static_cast<long>(i));
  }
}

// 802.11b: 1 Mb/s DBPSK spread by an 11-chip Barker code (a symbol is 1 us: 20 samples at 20 MS/s).
// The channel is the one whose matched filter shows the 1 us rhythm best; then symbol timing from
// it, DBPSK (a phase change of pi is a 1), the self-synchronising descrambler (x^7 + x^4 + 1), the long
// preamble's SFD, the PLCP header (CRC-16), the PSDU at 1 Mb/s (DBPSK) or 2 Mb/s (DQPSK), CRC-32, the
// MAC header. Short preambles and CCK (5.5, 11 Mb/s) payloads are not decoded.
void Decoder::dsss_at(uint64_t start, uint64_t end, std::vector<Frame> &out) {
  static const float barker[11] = {1, -1, 1, 1, -1, 1, 1, 1, -1, -1, -1};
  float tmpl[20];
  for (int n = 0; n < 20; n++)
    tmpl[n] = barker[std::min(10, n * 11 / 20)];
  const uint64_t len = end - start;
  const auto match = [&](const std::vector<cf> &z, size_t n, std::vector<cf> &y) {
    y.assign(n > 20 ? n - 20 : 0, cf(0));
    for (size_t m = 0; m < y.size(); m++) {
      cf acc = 0;
      for (int k = 0; k < 20; k++)
        acc += z[m + k] * tmpl[k];
      y[m] = acc;
    }
  };
  // the rhythm: the matched filter's power folded on 1 us; its peak against the mean
  const auto rhythm = [](const std::vector<cf> &y, size_t nsym, int &ph) {
    float fold[20] = {};
    for (size_t k = 0; k < nsym && 20 * k + 20 <= y.size(); k++)
      for (int p = 0; p < 20; p++)
        fold[p] += std::norm(y[20 * k + p]);
    float mx = 0, sum = 0;
    ph = 0;
    for (int p = 0; p < 20; p++) {
      sum += fold[p];
      if (fold[p] > mx) {
        mx = fold[p];
        ph = p;
      }
    }
    return sum > 0 ? mx / (sum / 20) : 0.f;
  };
  double best = 0, c = 0;
  std::vector<cf> y;
  const uint64_t probe = std::min<uint64_t>(len, static_cast<uint64_t>(110e-6 * _fs) + _lp.size());
  for (double cand : _cands) {
    if (cand > 3e9)
      continue;
    const auto z = snippet(start, probe, cand - _centre);
    match(z, z.size(), y);
    int ph;
    const double r = rhythm(y, 100, ph);
    if (r > best) {
      best = r;
      c = cand;
    }
  }
  if (best < 2.5)
    return; // no Barker rhythm: OFDM or something else
  const auto z = snippet(start, len, c - _centre);
  match(z, z.size(), y);
  int ph;
  const float r = rhythm(y, 100, ph);
  std::vector<cf> sym;
  for (size_t m = static_cast<size_t>(ph); m < y.size(); m += 20)
    sym.push_back(y[m]);
  if (sym.size() < 200)
    return;
  std::vector<uint8_t> raw(sym.size(), 0), bits(sym.size(), 0);
  for (size_t k = 1; k < sym.size(); k++)
    raw[k] = (sym[k] * std::conj(sym[k - 1])).real() < 0;
  const auto descr = [](const std::vector<uint8_t> &in, std::vector<uint8_t> &o) {
    o.assign(in.size(), 0);
    for (size_t i = 0; i < in.size(); i++)
      o[i] = in[i] ^ (i >= 4 ? in[i - 4] : 0) ^ (i >= 7 ? in[i - 7] : 0);
  };
  descr(raw, bits);
  // the long preamble's SFD, 0xF3A0 sent LSB first
  size_t sfd = 0;
  bool found = false;
  for (size_t k = 0; k + 16 + 48 <= bits.size() && k < 220 && !found; k++) {
    uint16_t v = 0;
    for (int j = 0; j < 16; j++)
      v |= static_cast<uint16_t>(bits[k + j] << j);
    if (v == 0xF3A0) {
      sfd = k;
      found = true;
    }
  }
  if (!found)
    return;
  const size_t h0 = sfd + 16;
  auto field = [&](size_t at, int n) {
    unsigned v = 0;
    for (int j = 0; j < n; j++)
      v |= static_cast<unsigned>(bits[at + j]) << j;
    return v;
  };
  // CRC-16 (CCITT, preset ones, ones' complement) over SIGNAL, SERVICE, LENGTH; sent MSB first
  unsigned reg = 0xFFFF;
  for (size_t j = 0; j < 32; j++) {
    const unsigned fb = ((reg >> 15) & 1) ^ bits[h0 + j];
    reg = (reg << 1) & 0xFFFF;
    if (fb)
      reg ^= 0x1021;
  }
  unsigned crc = 0;
  for (int j = 0; j < 16; j++)
    crc |= static_cast<unsigned>(bits[h0 + 32 + j]) << (15 - j);
  if ((reg ^ 0xFFFF) != crc)
    return;
  const unsigned sig = field(h0, 8), length_us = field(h0 + 16, 16);
  Frame f;
  f.fmt = 'B';
  f.rate_mbps = sig == 0x0A ? 1 : sig == 0x14 ? 2 : sig == 0x37 ? 5 : sig == 0x6E ? 11 : 0;
  if (!f.rate_mbps || length_us == 0)
    return;
  f.dur_us = 192 + length_us;
  f.length = static_cast<int>(sig == 0x0A ? length_us / 8 : sig == 0x14 ? length_us / 4 : length_us * f.rate_mbps / 8);
  f.centre_hz = c;
  f.bw_mhz = 22;
  f.snr_db = static_cast<float>(10 * std::log10(std::max(1.f, r - 1)));
  // the frame starts 144 symbols (SYNC 128 + SFD 16) before its header
  const double sync = static_cast<double>(ph) + 20.0 * (static_cast<double>(h0) - 144);
  f.t = _t_end - static_cast<double>(_abs_end - start) / _fs + sync / 20e6 + (_dec == 2 ? 10 / 20e6 : 0);
  const size_t p0 = h0 + 48, nb = static_cast<size_t>(f.length);
  std::vector<uint8_t> pb;
  if (sig == 0x0A && p0 + 8 * nb <= bits.size()) {
    pb.assign(bits.begin() + static_cast<long>(p0), bits.begin() + static_cast<long>(p0 + 8 * nb));
  } else if (sig == 0x14 && p0 + 4 * nb <= sym.size()) { // DQPSK: dibits from the phase change (Gray)
    std::vector<uint8_t> raw2(raw.begin(), raw.begin() + static_cast<long>(p0));
    for (size_t k = p0; k < p0 + 4 * nb; k++) {
      const double a = std::arg(sym[k] * std::conj(sym[k - 1]));
      const int q = static_cast<int>(std::lround((a < 0 ? a + 2 * kPi : a) / (kPi / 2))) % 4;
      static const uint8_t d0[4] = {0, 0, 1, 1}, d1[4] = {0, 1, 1, 0};
      raw2.push_back(d0[q]);
      raw2.push_back(d1[q]);
    }
    std::vector<uint8_t> all;
    descr(raw2, all);
    pb.assign(all.begin() + static_cast<long>(p0), all.end());
  }
  if (pb.size() == 8 * nb && nb >= 14) {
    std::vector<uint8_t> by(nb);
    for (size_t b = 0; b < nb; b++) {
      uint8_t v = 0;
      for (int j = 0; j < 8; j++)
        v |= static_cast<uint8_t>(pb[8 * b + j] << j);
      by[b] = v;
    }
    if (crc32(by.data(), nb - 4) == (by[nb - 4] | by[nb - 3] << 8 | by[nb - 2] << 16 | static_cast<uint32_t>(by[nb - 1]) << 24))
      parse_mac(by, f);
  }
  out.push_back(f);
}

} // namespace wifi
