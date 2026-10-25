// SPDX-License-Identifier: GPL-2.0-only
// Unit tests without hardware, plus `--bench`: the DSP at 40 MS/s on synthetic banks.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "dsp.h"
#include "protocol.h"
#include "receiver.h"

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
  CHECK(R::width_of(wsdr::RxSettings{5190e6, 1, true, false, 30}, true) == 20);
  CHECK(R::width_of(wsdr::RxSettings{5190e6, 2, true, false, 30}, false) == 20);
}

static void test_spectrum_tone() {
  // fs 20 MS/s, centre 5180 MHz, tone on bin 614 of 4096 (~ +3 MHz), half scale (-6.02 dBFS).
  // (Off a bin centre the Hann window reads up to 1.4 dB low: 3.000 MHz exactly gives -6.93.)
  const double fs = 20e6, f = 614 * fs / 4096;
  Spectrum sp;
  DspConfig c;
  c.fft = 4096;
  c.rows_per_s = 50;
  c.paths = 3;
  c.dc_remove = false;
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 1;
  m.fs = fs;
  m.centre_hz = 5180e6;
  m.paths = 2;
  std::vector<Row> rows;
  for (int k = 0; k < 64; k++) {
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

static void test_shift() {
  // Requested 5182 MHz, hardware centre 5180 MHz: a tone at the hardware's +2 MHz must land at 5182.
  Spectrum sp;
  DspConfig c;
  c.fft = 2048;
  c.rows_per_s = 50;
  c.dc_remove = false;
  sp.configure(c);
  wsdr::BankMeta m;
  m.gen = 7;
  m.fs = 20e6;
  m.centre_hz = 5180e6;
  m.shift_hz = 2e6;
  std::vector<Row> rows;
  for (int k = 0; k < 64; k++) {
    auto b = tone_bank(2e6, 20e6, 1024, static_cast<uint64_t>(k) * 8192);
    sp.process(b.data(), b.size(), m, [&](const Row &r) { rows.push_back(r); });
  }
  CHECK(!rows.empty());
  const Row &r = rows.back();
  size_t pk = 0;
  for (size_t i = 1; i < r.avg.size(); i++)
    if (r.avg[i] > r.avg[pk])
      pk = i;
  CHECK(std::abs(r.f0 + r.df * pk - 5182e6) <= r.df);
  CHECK(std::abs(r.f0 + r.df * r.avg.size() / 2 - 5182e6) <= r.df); // display centred on the request
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

int main(int argc, char **argv) {
  if (argc > 1 && std::string(argv[1]) == "--bench")
    return bench();
  test_channels();
  test_spectrum_tone();
  test_shift();
  test_reduce_and_frame();
  std::printf(g_fail ? "%d FAILED\n" : "all tests passed\n", g_fail);
  return g_fail ? 1 : 0;
}
