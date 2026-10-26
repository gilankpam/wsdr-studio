// SPDX-License-Identifier: GPL-2.0-only
// Unit tests without hardware, plus `--bench`: the DSP at 40 MS/s on synthetic banks, and
// `--wifi <recording.sigmf-data>`: the Wi-Fi frame finder over a recording, summarised.
#include <array>
#include <chrono>
#include <complex>
#include <fstream>
#include <map>
#include <random>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "dsp.h"
#include "protocol.h"
#include "receiver.h"
#include "wifi.h"

using namespace studio;

static int g_fail = 0;
#define CHECK(c)                                                                                   \
  do {                                                                                             \
    if (!(c)) {                                                                                    \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #c);                                     \
      g_fail++;                                                                                    \
    }                                                                                              \
  } while (0)

// LA bank with a complex tone at f_hz (amplitude amp LSB) on path A, and path B = path A * j.
static std::vector<uint8_t> tone_bank(double f_hz, double fs, double amp, uint64_t start) {
  std::vector<uint8_t> b(65536);
  for (size_t i = 0; i < 8192; i++) {
    const double ph = 2 * M_PI * f_hz * static_cast<double>(start + i) / fs;
    const int I = static_cast<int>(std::lround(amp * std::cos(ph))), Q = static_cast<int>(std::lround(amp * std::sin(ph)));
    const uint64_t w = (static_cast<uint64_t>(I & 0xFFF)) | (static_cast<uint64_t>(Q & 0xFFF) << 12) |
                       (static_cast<uint64_t>((-Q) & 0xFFF) << 44) | (static_cast<uint64_t>(I & 0xFFF) << 32);
    std::memcpy(b.data() + 8 * i, &w, 8);
  }
  return b;
}

static void test_channels() {
  using R = wsdr::Receiver;
  CHECK(R::channel_for(5180e6, 20) == 36);
  CHECK(R::channel_for(5190e6, 40) == 36);
  CHECK(std::abs(R::centre_of(36, 40) - 5190e6) < 1);
  CHECK(R::channel_for(5230e6, 40) == 44);
  CHECK(R::channel_for(2412e6, 20) == 1);
  CHECK(R::channel_for(2484e6, 20) == 14);
  CHECK(R::channel_for(5182e6, 20) == 36); // residual 2 MHz is shifted digitally
  CHECK(R::igi_for(0, false) == 0x50);
  CHECK(R::igi_for(100, false) == 0x1C);
  CHECK(R::width_of(wsdr::RxSettings{5190e6, 1, true, false, 30}, false) == 40);
  CHECK(R::width_of(wsdr::RxSettings{5190e6, 1, true, false, 30}, true) == 40); // 8822C gapped 40 MS/s
  CHECK(R::width_of(wsdr::RxSettings{5190e6, 2, true, false, 30}, false) == 20);
}

static void test_spectrum_tone() {
  // fs 20 MS/s, centre 5180 MHz, tone on bin 614 of 4096 (~ +3 MHz), half scale (-6.02 dBFS).
  // (Off a bin centre the Hann window reads up to 1.4 dB low: 3.000 MHz exactly gives -6.93.)
  const double fs = 20e6, f = 614 * fs / 4096;
  Spectrum sp;
  DspConfig c;
  c.fft = 4096;
  c.rows_per_s = 30;
  c.paths = 3;
  c.dc_remove = false;
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 1;
  m.fs = fs;
  m.centre_hz = 5180e6;
  m.paths = 2;
  std::vector<Row> rows;
  for (int k = 0; k < 160; k++) { // >= 2 rows at the 30 rows/s cap
    auto b = tone_bank(f, fs, 1024, static_cast<uint64_t>(k) * 8192);
    m.seq = k;
    sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
  }
  CHECK(!rows.empty());
  for (const Row &r : rows) {
    size_t pk = 0;
    for (size_t i = 1; i < r.avg.size(); i++)
      if (r.avg[i] > r.avg[pk])
        pk = i;
    const double fpk = r.f0 + r.df * pk;
    CHECK(std::abs(fpk - (5180e6 + f)) <= r.df);
    if (getenv("DUMP") || std::abs(r.avg[pk] - (-6.02f)) >= 0.5f)
      std::printf("  row seq %u path %d peak %.2f dBFS at %.0f Hz\n", r.seq, r.path, r.avg[pk], r.f0 + r.df * pk);
    CHECK(std::abs(r.avg[pk] - (-6.02f)) < 0.5f); // half scale, tone on a bin centre
    CHECK(r.avg.size() == 4096);
  }
  // path B = j * A: same spectrum
  int a = 0, bcount = 0;
  for (const Row &r : rows)
    (r.path ? bcount : a)++;
  CHECK(a > 0 && bcount > 0);
}

static void test_offgrid() {
  // Requested 5182 MHz at 5 MS/s: the hardware sits at 5180 (5 MHz grid). The rows must show the
  // hardware band 5177.5..5182.5 (no wrap-around), with a tone at the hardware's +2 MHz at 5182.
  Spectrum sp;
  DspConfig c;
  c.fft = 2048;
  c.rows_per_s = 25;
  c.dc_remove = false;
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 7;
  m.fs = 5e6;
  m.centre_hz = 5180e6;
  m.shift_hz = 2e6;
  std::vector<Row> rows;
  for (int k = 0; k < 64; k++) {
    auto b = tone_bank(2e6, 5e6, 1024, static_cast<uint64_t>(k) * 8192);
    sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
  }
  CHECK(!rows.empty());
  if (rows.empty())
    return;
  const Row &r = rows.back();
  size_t pk = 0;
  for (size_t i = 1; i < r.avg.size(); i++)
    if (r.avg[i] > r.avg[pk])
      pk = i;
  CHECK(std::abs(r.f0 + r.df * pk - 5182e6) <= r.df);
  CHECK(std::abs(r.f0 - r.df / 2 - 5177.5e6) <= r.df); // band starts at centre - fs/2
}

static void test_level_vs_fft() {
  // A tone on a bin centre reads -6.02 dBFS at FFT 4096. At 16384 (reduced to 4096 display bins by
  // summing power) the display bin also holds the Hann window's leakage: up to +1.76 dB.
  for (int n : {4096, 16384}) {
    Spectrum sp;
    DspConfig c;
    c.fft = n;
    c.rows_per_s = 25;
    c.dc_remove = false;
    sp.configure(c);
    wsdr::BankMeta m;
    m.gen = 1;
    m.fs = 20e6;
    m.centre_hz = 5180e6;
    std::vector<Row> rows;
    const double f = 512 * 20e6 / 4096; // on a bin centre at both sizes
    for (int k = 0; k < 120; k++) {
      auto b = tone_bank(f, 20e6, 1024, static_cast<uint64_t>(k) * 8192);
      sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
    }
    CHECK(!rows.empty());
    if (rows.empty())
      continue;
    float pk = -200, pkmax = -200;
    for (float v : rows.back().avg)
      pk = std::max(pk, v);
    for (float v : rows.back().max)
      pkmax = std::max(pkmax, v);
    CHECK(std::abs(pkmax - pk) < 0.3f); // a steady tone: peak trace = average trace (same units)
    const float hi = n > 4096 ? -6.02f + 1.8f : -6.02f + 0.3f;
    if (pk < -6.32f || pk > hi)
      std::printf("  fft %d peak %.2f dBFS\n", n, pk);
    CHECK(pk >= -6.32f && pk <= hi);
  }
}

static void test_reduce_and_frame() {
  Spectrum sp;
  DspConfig c;
  c.fft = 16384;
  c.rows_per_s = 50; // 800k samples per row at 40 MS/s: ~98 banks
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 1;
  m.fs = 40e6;
  m.centre_hz = 5190e6;
  std::vector<Row> rows;
  for (int k = 0; k < 200; k++) {
    auto b = tone_bank(5e6, 40e6, 512, static_cast<uint64_t>(k) * 8192);
    sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
  }
  CHECK(!rows.empty());
  if (rows.empty())
    return;
  CHECK(rows[0].avg.size() == kMaxBins);
  const auto frame = encode_row(rows[0], 1.25);
  DecodedRow d;
  CHECK(decode_row(frame.data(), frame.size(), d));
  CHECK(d.bins == kMaxBins && d.seq == rows[0].seq && d.f0 == rows[0].f0 && d.df == rows[0].df);
  CHECK(d.gen == 1); // the run byte (meta.gen & 0xff) travels with every row
  for (size_t i = 0; i < d.bins; i++) {
    if (rows[0].avg[i] > kDbMin && rows[0].avg[i] < kDbMin + 255 * kDbStep)
      CHECK(std::abs(d.avg[i] - rows[0].avg[i]) <= kDbStep / 2 + 1e-3f);
  }
  CHECK(!decode_row(frame.data(), frame.size() - 1, d));
}

static int bench() {
  // 40 MS/s for 2 s of signal: 9766 banks, FFT 8192, 25 rows/s.
  Spectrum sp;
  DspConfig c;
  c.fft = 8192;
  c.rows_per_s = 25;
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 1;
  m.fs = 40e6;
  m.centre_hz = 5190e6;
  m.shift_hz = 1.5e6;
  auto b = tone_bank(3e6, 40e6, 800, 0);
  const int banks = 9766;
  int rows = 0;
  const auto t0 = std::chrono::steady_clock::now();
  for (int k = 0; k < banks; k++) {
    m.seq = k;
    sp.process(b.data(), b.size(), m, [&](const Row &) { rows++; });
  }
  const double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  const double sig = banks * 8192 / 40e6;
  std::printf("{\"bench\":\"dsp\",\"fs\":40e6,\"fft\":8192,\"signal_s\":%.3f,\"cpu_s\":%.3f,\"load\":%.3f,\"ffts\":%llu,"
              "\"rows\":%d}\n", sig, el, el / sig, static_cast<unsigned long long>(sp.ffts()), rows);
  return el / sig < 0.5 ? 0 : 1;
}

// Gapped runs: the FFT is capped at one bank, a tone still lands in its bin, and rows follow the clock
// (not the sample count, which is only a fraction of fs).
static void test_gapped() {
  Spectrum sp;
  double now = 0;
  sp.clock = [&] { return now; };
  DspConfig c;
  c.fft = 16384;
  c.rows_per_s = 10;
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 1;
  m.fs = 40e6;
  m.centre_hz = 5190e6;
  m.gapped = true;
  std::vector<Row> rows;
  for (int k = 0; k < 600; k++) { // 555 banks/s, as measured at 40 MS/s: ~1.08 s
    now = k / 555.0;
    // each bank its own capture: the phase restarts (a gap), the tone is the same
    auto b = tone_bank(5e6, 40e6, 512, 0);
    sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
  }
  CHECK(sp.fft_size() == kGappedMaxFft);
  if (!rows.empty()) { // the gapped flag travels with the row
    DecodedRow d;
    const auto fr = encode_row(rows[0], 0);
    CHECK(rows[0].gapped && decode_row(fr.data(), fr.size(), d) && d.gapped && d.path == 0);
  }
  CHECK(rows.size() >= 9 && rows.size() <= 11); // 10 rows/s by the clock
  if (rows.empty())
    return;
  const Row &r = rows.back();
  int best = 0;
  for (int i = 1; i < static_cast<int>(r.avg.size()); i++)
    if (r.avg[i] > r.avg[best])
      best = i;
  CHECK(std::abs(r.f0 + best * r.df - (5190e6 + 5e6)) <= r.df);
  // back to a continuous run: the configured size again
  m.gen = 2;
  m.gapped = false;
  auto b = tone_bank(5e6, 40e6, 512, 0);
  sp.process(b.data(), b.size(), m, [](const Row &) {});
  CHECK(sp.fft_size() == 16384);
}

// Offset tuning: a crop window emits only its bins, with the right f0, and flags the rows.
static void test_crop() {
  Spectrum sp;
  DspConfig c;
  c.fft = 8192;
  c.rows_per_s = 50;
  sp.configure(c);
  sp.set_crop(5795e6, 5815e6); // channel 161 viewed from a radio centred at 5815 MHz (40 MS/s)
  wsdr::BankMeta m;
  m.gen = 1;
  m.fs = 40e6;
  m.centre_hz = 5815e6;
  std::vector<Row> rows;
  for (int k = 0; k < 200; k++) {
    auto b = tone_bank(-12e6, 40e6, 512, static_cast<uint64_t>(k) * 8192); // 5803 MHz
    sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
  }
  CHECK(!rows.empty());
  if (rows.empty())
    return;
  const Row &r = rows.back();
  CHECK(r.offset && r.avg.size() >= 2040 && r.avg.size() <= 2050); // 20 of 40 MHz at 4096 bins
  CHECK(r.f0 >= 5795e6 - r.df && r.f0 <= 5795e6 + r.df);
  int best = 0;
  for (int i = 1; i < static_cast<int>(r.avg.size()); i++)
    if (r.avg[i] > r.avg[best])
      best = i;
  CHECK(std::abs(r.f0 + best * r.df - 5803e6) <= r.df);
  DecodedRow d;
  const auto fr = encode_row(r, 0);
  CHECK(decode_row(fr.data(), fr.size(), d) && d.offset && !d.gapped && d.path == 0);
}

// An 802.11a PPDU header (STF, LTF, L-SIG, then `extra` symbols) synthesised directly at 40 MS/s on
// the 20 MHz channel `off_hz` from the centre (+-10 MHz: the 312.5 kHz subcarriers land on bins of a
// 128-point IFFT). ht: the two symbols after L-SIG are QBPSK (HT-SIG), else BPSK.
static std::vector<std::complex<float>> ofdm_frame(int rate_code, int length, double off_hz, bool ht, int extra, std::mt19937 &rng) {
  using C = std::complex<float>;
  const int shift = static_cast<int>(std::lround(off_hz / 312.5e3));
  auto sym = [&](const std::array<C, 64> &sc, int cp) { // sc by subcarrier -32..31 (index s + 32)
    std::array<C, 128> f{};
    for (int s = -32; s < 32; s++)
      f[(s + shift + 128) % 128] = sc[s + 32];
    std::vector<C> t(128);
    for (int n = 0; n < 128; n++) {
      C acc = 0;
      for (int k = 0; k < 128; k++)
        acc += f[k] * std::polar(1.f, static_cast<float>(2 * M_PI * k * n / 128));
      t[n] = acc / 128.f;
    }
    std::vector<C> out(t.end() - cp, t.end());
    out.insert(out.end(), t.begin(), t.end());
    return out;
  };
  std::vector<C> x;
  // STF: 12 subcarriers, 0.8 us period (32 samples here), 8 us
  std::array<C, 64> stf{};
  const int stf_sc[12] = {-24, -20, -16, -12, -8, -4, 4, 8, 12, 16, 20, 24};
  const float stf_v[12] = {1, -1, 1, -1, -1, 1, -1, -1, 1, 1, 1, 1};
  for (int i = 0; i < 12; i++)
    stf[stf_sc[i] + 32] = C(stf_v[i], stf_v[i]) * std::sqrt(13.f / 6.f);
  auto st = sym(stf, 0);
  for (int r = 0; r < 2; r++)
    x.insert(x.end(), st.begin(), st.end()); // 256
  x.insert(x.end(), st.begin(), st.begin() + 64); // 320 = 8 us
  const int ltf[53] = {1, 1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1, 1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 0,
                       1, -1, -1, 1, 1, -1, 1, -1, 1, -1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1, 1, -1, 1, 1, 1, 1};
  std::array<C, 64> lf{};
  for (int i = 0; i < 53; i++)
    lf[i - 26 + 32] = static_cast<float>(ltf[i]);
  auto lt = sym(lf, 0);
  x.insert(x.end(), lt.end() - 64, lt.end()); // GI2
  x.insert(x.end(), lt.begin(), lt.end());
  x.insert(x.end(), lt.begin(), lt.end());
  // L-SIG bits, convolutional code, interleaver, BPSK
  int bits[24] = {};
  for (int i = 0; i < 4; i++)
    bits[i] = (rate_code >> (3 - i)) & 1;
  for (int i = 0; i < 12; i++)
    bits[5 + i] = (length >> i) & 1;
  int par = 0;
  for (int i = 0; i < 17; i++)
    par ^= bits[i];
  bits[17] = par;
  int coded[48], reg = 0;
  for (int i = 0; i < 24; i++) {
    const int r = (bits[i] << 6) | reg;
    coded[2 * i] = __builtin_parity(r & 0133);
    coded[2 * i + 1] = __builtin_parity(r & 0171);
    reg = r >> 1;
  }
  std::vector<int> dsc;
  for (int s = -26; s <= 26; s++)
    if (s != 0 && s != -21 && s != -7 && s != 7 && s != 21)
      dsc.push_back(s);
  const int pol[3] = {1, 1, 1};
  auto data_sym = [&](const int *cb, int p, C rot) {
    std::array<C, 64> sc{};
    for (int k = 0; k < 48; k++)
      sc[dsc[3 * (k % 16) + k / 16] + 32] = rot * static_cast<float>(2 * cb[k] - 1);
    const int ps[4] = {-21, -7, 7, 21}, pv[4] = {1, 1, 1, -1};
    for (int i = 0; i < 4; i++)
      sc[ps[i] + 32] = static_cast<float>(pv[i] * p);
    return sym(sc, 32);
  };
  auto sg = data_sym(coded, pol[0], 1);
  x.insert(x.end(), sg.begin(), sg.end());
  std::uniform_int_distribution<int> bit(0, 1);
  for (int e = 0; e < extra; e++) {
    int cb[48];
    for (int &b : cb)
      b = bit(rng);
    const int p = e < 2 ? pol[e + 1] : 1;
    auto d = data_sym(cb, p, ht && e < 2 ? C(0, 1) : C(1, 0));
    x.insert(x.end(), d.begin(), d.end());
  }
  return x;
}

static void test_wifi_frames() {
  std::mt19937 rng(7);
  std::normal_distribution<float> g(0, 1);
  const double fs = 40e6, centre = 5190e6;
  wifi::Decoder dec;
  dec.reset(fs, centre);
  std::vector<std::complex<float>> x;
  auto noise = [&](size_t n, float sd) {
    for (size_t i = 0; i < n; i++)
      x.emplace_back(sd * g(rng), sd * g(rng));
  };
  // three frames: 24 Mb/s legacy on 5200 (+10 MHz), an HT one on 5180 (-10), 6 Mb/s legacy on 5200
  struct Want { int code, rate, len; double off; bool ht; size_t at; };
  std::vector<Want> want = {{0b1001, 24, 100, 10e6, false, 0}, {0b1101, 6, 1500, -10e6, true, 0}, {0b1101, 6, 14, 10e6, false, 0}};
  noise(30000, 0.05f);
  for (auto &w : want) {
    if (&w == &want[1]) { // a long burst at the frame's power just before (an A-MPDU): the noise floor must not rise to it
      for (size_t i = 0; i < 120000; i++) // 3 ms
        x.emplace_back(0.7f * g(rng), 0.7f * g(rng));
      noise(800, 0.05f); // 20 us
    }
    w.at = x.size();
    auto f = ofdm_frame(w.code, w.len, w.off, w.ht, 6, rng);
    const double cfo = 60e3; // like two adapters' crystals apart
    for (size_t i = 0; i < f.size(); i++)
      x.push_back(f[i] * std::polar(1.f, static_cast<float>(2 * M_PI * cfo * static_cast<double>(i) / fs)) * 8.9f + // ~17 dB SNR
                  std::complex<float>(0.05f * g(rng), 0.05f * g(rng)));
    noise(20000, 0.05f);
  }
  std::vector<wifi::Frame> got;
  for (size_t i = 0; i < x.size(); i += 8192) {
    const size_t n = std::min<size_t>(8192, x.size() - i);
    dec.feed(&x[i], n, static_cast<double>(i + n) / fs, got);
  }
  CHECK(got.size() == want.size());
  if (got.size() != want.size())
    for (const auto &f : got)
      std::printf("  got t %.6f c %.0f %c rate %d len %d snr %.1f\n", f.t, f.centre_hz / 1e6, f.fmt, f.rate_mbps, f.length, f.snr_db);
  for (size_t i = 0; i < std::min(got.size(), want.size()); i++) {
    const auto &f = got[i];
    const auto &w = want[i];
    CHECK(f.rate_mbps == w.rate && f.length == w.len);
    CHECK(std::abs(f.centre_hz - (centre + w.off)) < 1);
    CHECK(f.fmt == (w.ht ? 'H' : 'L'));
    CHECK(std::abs(f.t - static_cast<double>(w.at) / fs) < 3e-6); // where its preamble starts
    CHECK(f.snr_db > 15);
    if (w.len == 14)
      CHECK(std::abs(f.dur_us - (20 + 4 * 6)) < 1e-9); // an ACK at 6 Mb/s: 44 us
  }
}

// --wifi <file.sigmf-data>: the frame finder over a recording (ci16, rate and centre from its meta).
static int wifi_scan(const char *path) {
  std::string p(path), mp = p.substr(0, p.rfind(".sigmf-data")) + ".sigmf-meta";
  std::ifstream m(mp);
  std::string meta((std::istreambuf_iterator<char>(m)), std::istreambuf_iterator<char>());
  auto num = [&](const char *key) {
    const auto k = meta.find(key);
    return k == std::string::npos ? 0.0 : std::atof(meta.c_str() + meta.find(':', k + std::strlen(key)) + 1);
  };
  const double fs = num("\"core:sample_rate\""), fc = num("\"core:frequency\"");
  std::ifstream f(p, std::ios::binary);
  wifi::Decoder dec;
  dec.reset(fs, fc);
  std::vector<int16_t> raw(2 * 8192);
  std::vector<std::complex<float>> x(8192);
  std::vector<wifi::Frame> got;
  uint64_t done = 0;
  const auto t0 = std::chrono::steady_clock::now();
  while (f.read(reinterpret_cast<char *>(raw.data()), static_cast<std::streamsize>(raw.size() * 2))) {
    for (size_t i = 0; i < 8192; i++)
      x[i] = {raw[2 * i] / 16.f, raw[2 * i + 1] / 16.f};
    done += 8192;
    dec.feed(x.data(), 8192, static_cast<double>(done) / fs, got);
  }
  const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  std::map<std::string, int> by;
  for (const auto &fr : got) {
    char k[64];
    std::snprintf(k, sizeof k, "%.0f MHz %d MHz %c %2d Mb/s", fr.centre_hz / 1e6, fr.bw_mhz, fr.fmt, fr.rate_mbps);
    by[k]++;
  }
  std::printf("%.2f s of %.0f MS/s at %.1f MHz: %zu frames (decoded in %.2f s, %.1fx real time)\n", static_cast<double>(done) / fs,
              fs / 1e6, fc / 1e6, got.size(), secs, static_cast<double>(done) / fs / secs);
  for (const auto &[k, n] : by)
    std::printf("  %-28s %d\n", k.c_str(), n);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 2 && std::string(argv[1]) == "--wifi")
    return wifi_scan(argv[2]);
  if (argc > 1 && std::string(argv[1]) == "--bench")
    return bench();
  test_channels();
  test_spectrum_tone();
  test_offgrid();
  test_level_vs_fft();
  test_reduce_and_frame();
  test_gapped();
  test_crop();
  test_wifi_frames();
  std::printf(g_fail ? "%d FAILED\n" : "all tests passed\n", g_fail);
  return g_fail ? 1 : 0;
}
