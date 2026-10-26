// SPDX-License-Identifier: GPL-2.0-only
// wsdr-probe: the WebUSB spike. Runs in a Web Worker (one thread: libusb's Emscripten backend talks to
// WebUSB from the thread the module started on). Each export blocks (JSPI / Asyncify suspend while
// WebUSB promises are pending) and prints JSON lines, which the worker forwards to the page.
//   probe_list()                              adapters the page was granted, with speed
//   probe_stream(pid, rate_sel, seconds, depth, reset, freq_mhz)
//                                             bring up, stream one run, report banks and timings
//   probe_usb3(pid)                           the 8812BU's switch to USB 3 (it re-enumerates)
//   probe_rx(pid, rate_sel, seconds)          wsdr::Receiver as the app uses it (its own stream thread,
//                                             opened from a command thread): libusb forwards every USB
//                                             call from those pthreads to this module's main thread,
//                                             which must stay idle. Returns at once; ends with "rxtest".
// Mirrors one pass of wsdr::Receiver::worker() without its thread, and with devourer's thermal thread
// off (it would do register I/O from a second thread).
#include <emscripten.h>
#include <libusb.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <thread>

#include "receiver.h"
#include "session.h"
#include "stream88xx.h"
#include "stream_cu.h"
#include "usbmode.h"

using namespace wsdr;
using clk = std::chrono::steady_clock;

namespace {
std::string esc(const std::string &s) {
  std::string o;
  for (char c : s)
    if (c == '"' || c == '\\')
      o += '\\', o += c;
    else if (static_cast<unsigned char>(c) >= 0x20)
      o += c;
  return o;
}
double secs(clk::time_point a, clk::time_point b) { return std::chrono::duration<double>(b - a).count(); }
} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int probe_list() {
  libusb_context *ctx = nullptr;
  if (int rc = libusb_init(&ctx); rc != 0) {
    std::printf("{\"ev\":\"list\",\"ok\":0,\"error\":\"libusb_init: %s\"}\n", libusb_error_name(rc));
    return 1;
  }
  libusb_device **list = nullptr;
  const ssize_t n = libusb_get_device_list(ctx, &list);
  for (ssize_t i = 0; i < n; i++) {
    libusb_device_descriptor d{};
    libusb_get_device_descriptor(list[i], &d);
    std::printf("{\"ev\":\"device\",\"vid\":\"%04x\",\"pid\":\"%04x\",\"bcdUSB\":\"%04x\",\"ep0\":%u,"
                "\"speed\":%d,\"bus\":%u,\"port\":%u}\n",
                d.idVendor, d.idProduct, d.bcdUSB, d.bMaxPacketSize0, libusb_get_device_speed(list[i]),
                libusb_get_bus_number(list[i]), libusb_get_port_number(list[i]));
  }
  std::printf("{\"ev\":\"list\",\"ok\":1,\"n\":%d}\n", static_cast<int>(n));
  if (list)
    libusb_free_device_list(list, 1);
  libusb_exit(ctx);
  std::fflush(stdout);
  return 0;
}

EMSCRIPTEN_KEEPALIVE int probe_stream(int pid, int rate_sel, double seconds, int depth, int reset, double freq_mhz) {
  const bool cu = pid == kPid8812cu;
  const auto t_open = clk::now();
  auto s = std::make_unique<Session>(std::make_shared<Logger>());
  OpenOpts o;
  o.pid = static_cast<uint16_t>(pid);
  o.reset = reset != 0;
  o.thermal_track = false;
  RxSettings set;
  set.freq = freq_mhz * 1e6;
  set.rate_sel = rate_sel;
  const int width = Receiver::width_of(set, cu);
  o.bw = width;
  o.channel = Receiver::channel_for(set.freq, width);
  try {
    s->open(o);
  } catch (const OpenError &e) {
    std::printf("{\"ev\":\"open\",\"ok\":0,\"kind\":%d,\"error\":\"%s\"}\n", static_cast<int>(e.kind), esc(e.what()).c_str());
    return 3;
  } catch (const std::exception &e) {
    std::printf("{\"ev\":\"open\",\"ok\":0,\"error\":\"%s\"}\n", esc(e.what()).c_str());
    return 3;
  }
  if (cu)
    s->reg().set_cap(4);
  const auto t_up = clk::now();
  std::printf("{\"ev\":\"open\",\"ok\":1,\"chip\":\"%s\",\"superspeed\":%d,\"channel\":%d,\"width\":%d,"
              "\"bringup_s\":%.2f,\"ep0_transfers\":%llu}\n",
              esc(s->chip()).c_str(), s->superspeed(), o.channel, width, secs(t_open, t_up),
              static_cast<unsigned long long>(s->reg().transfers()));
  std::fflush(stdout);

  StreamCfg c;
  c.la.rate_sel = rate_sel;
  c.depth = depth > 0 ? depth : (cu || rate_sel <= 2 ? 256 : 64);
  c.la.igi = Receiver::igi_for(set.gain_db, cu);
  c.la.no_cca = true;
  c.la.dfir = !cu && width == 40 ? 40 : 0;
  const int min_rate_sel = s->superspeed() && !cu ? 1 : 4;
  c.gapped = rate_sel < min_rate_sel;
  const double fs = Receiver::rate_of(rate_sel);

  uint64_t banks = 0, stale = 0, sec_banks = 0;
  double late_max = 0, end_max = 0;
  uint64_t checksum = 0;
  clk::time_point t0{}, sec_t{}, t_last{};
  const auto on_bank = [&](const uint8_t *bank, const BankInfo &bi) {
    const auto now = clk::now();
    if (!banks)
      t0 = sec_t = now;
    banks++;
    sec_banks++;
    t_last = now;
    stale += bi.stale;
    late_max = std::max(late_max, bi.late_us);
    end_max = std::max(end_max, bi.end_us);
    checksum += bank[0] ^ bank[Stream8822b::kBankBytes - 1]; // touch the data, as a consumer would
    if (secs(sec_t, now) >= 1.0) {
      const double el = secs(sec_t, now);
      std::printf("{\"ev\":\"status\",\"t\":%.1f,\"banks\":%llu,\"msps\":%.2f,\"usb_mbs\":%.1f}\n", secs(t0, now),
                  static_cast<unsigned long long>(banks), sec_banks * 8192.0 / el / 1e6,
                  sec_banks * 65536.0 / el / 1e6);
      std::fflush(stdout);
      sec_banks = 0;
      sec_t = now;
    }
    return secs(t0, now) < seconds;
  };
  StreamStats ss;
  try {
    ss = cu ? Stream8822c(*s, c).run(on_bank) : Stream8822b(*s, c).run(on_bank);
  } catch (const std::exception &e) {
    ss.error = e.what();
  }
  const double el = banks > 1 ? secs(t0, t_last) : 0; // first to last bank, not the teardown
  std::printf("{\"ev\":\"stream\",\"rate_sel\":%d,\"fs_msps\":%.2f,\"gapped\":%d,\"depth\":%d,\"banks\":%llu,"
              "\"seconds\":%.2f,\"msps\":%.2f,\"usb_mbs\":%.1f,\"stale\":%llu,\"strays\":%u,\"start_retries\":%u,"
              "\"late_max_us\":%.1f,\"end_max_us\":%.1f,\"period_us\":%.1f,\"error\":\"%s\"}\n",
              rate_sel, fs / 1e6, c.gapped, c.depth, static_cast<unsigned long long>(banks), el,
              el > 0 ? banks * 8192.0 / el / 1e6 : 0.0, el > 0 ? banks * 65536.0 / el / 1e6 : 0.0,
              static_cast<unsigned long long>(stale), ss.strays, ss.start_retries, std::max(late_max, ss.late_max_us),
              std::max(end_max, ss.end_max_us), 8192.0 / fs * 1e6, esc(ss.error).c_str());
  std::fflush(stdout);
  (void)checksum;
  s.reset();
  return ss.error.empty() ? 0 : 1;
}

EMSCRIPTEN_KEEPALIVE int probe_usb3(int pid) {
  libusb_context *ctx = nullptr;
  if (libusb_init(&ctx) != 0)
    return 1;
  libusb_device **list = nullptr;
  const ssize_t n = libusb_get_device_list(ctx, &list);
  int bus = -1;
  std::string port;
  for (ssize_t i = 0; i < n && bus < 0; i++) {
    libusb_device_descriptor d{};
    if (libusb_get_device_descriptor(list[i], &d) == 0 && d.idProduct == pid) {
      bus = libusb_get_bus_number(list[i]);
      port = std::to_string(libusb_get_port_number(list[i]));
    }
  }
  if (list)
    libusb_free_device_list(list, 1);
  libusb_exit(ctx);
  std::string detail;
  const Usb3Switch r = bus < 0 ? Usb3Switch::Failed : request_usb3(static_cast<uint16_t>(pid), bus, port, &detail);
  std::printf("{\"ev\":\"usb3\",\"result\":\"%s\",\"detail\":\"%s\"}\n", usb3_switch_name(r),
              esc(bus < 0 ? "adapter not found" : detail).c_str());
  std::fflush(stdout);
  return 0;
}

EMSCRIPTEN_KEEPALIVE int probe_rx(int pid, int rate_sel, double seconds) {
  std::thread([=] {
    Receiver rx(std::make_shared<Logger>());
    RxSettings set;
    set.freq = 5190e6;
    set.rate_sel = rate_sel;
    set.allow_gapped = true;
    const auto t_open = clk::now();
    try {
      rx.open(static_cast<uint16_t>(pid), set);
    } catch (const std::exception &e) {
      std::printf("{\"ev\":\"rxtest\",\"ok\":0,\"error\":\"%s\"}\n", esc(e.what()).c_str());
      std::fflush(stdout);
      return;
    }
    std::printf("{\"ev\":\"open\",\"ok\":1,\"via\":\"receiver\",\"bringup_s\":%.2f}\n", secs(t_open, clk::now()));
    std::fflush(stdout);
    std::atomic<uint64_t> banks{0};
    static uint8_t copy[65536];
    rx.start([&](const uint8_t *bank, size_t n, const BankMeta &) {
      std::memcpy(copy, bank, n);
      banks++;
    });
    const auto t0 = clk::now();
    uint64_t last = 0;
    while (secs(t0, clk::now()) < seconds) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
      const RxStatus st = rx.status();
      const uint64_t b = banks.load();
      std::printf("{\"ev\":\"status\",\"state\":\"%s\",\"msps\":%.2f,\"restarts\":%llu,\"error\":\"%s\"}\n",
                  rx_state_name(st.state), (b - last) * 8192.0 / 1e6, static_cast<unsigned long long>(st.restarts),
                  esc(st.error).c_str());
      std::fflush(stdout);
      last = b;
      if (st.state == RxState::Lost || st.state == RxState::Error)
        break;
    }
    const double el = secs(t0, clk::now());
    rx.stop();
    const RxStatus st = rx.status();
    std::printf("{\"ev\":\"rxtest\",\"ok\":1,\"rate_sel\":%d,\"banks\":%llu,\"msps\":%.2f,\"restarts\":%llu,"
                "\"state\":\"%s\",\"error\":\"%s\"}\n",
                rate_sel, static_cast<unsigned long long>(banks.load()), banks * 8192.0 / el / 1e6,
                static_cast<unsigned long long>(st.restarts), rx_state_name(st.state), esc(st.error).c_str());
    std::fflush(stdout);
    rx.close();
  }).detach();
  return 0;
}

} // extern "C"

int main() { return 0; }
