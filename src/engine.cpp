// SPDX-License-Identifier: GPL-2.0-only
#include "engine.h"

#include <sys/statvfs.h>

#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>

#include "logger.h"
#include "protocol.h"

namespace studio {

namespace {
using clk = std::chrono::steady_clock;
const clk::time_point g_t0 = clk::now();
double now_s() { return std::chrono::duration<double>(clk::now() - g_t0).count(); }

const char *open_kind(wsdr::OpenError::Kind k) {
  switch (k) {
  case wsdr::OpenError::NotFound: return "not_found";
  case wsdr::OpenError::Permission: return "permission";
  case wsdr::OpenError::Busy: return "busy";
  default: return "other";
  }
}

struct CmdError : std::runtime_error {
  std::string kind;
  CmdError(std::string k, const std::string &m) : std::runtime_error(m), kind(std::move(k)) {}
};

// Validated field access for client JSON: wrong types and out-of-range values are request errors.
int integer(const json &c, const char *k, int lo, int hi) {
  const json &v = c.at(k);
  if (!v.is_number_integer() || v.get<int64_t>() < lo || v.get<int64_t>() > hi)
    throw CmdError("bad_request", std::string(k) + " must be an integer in [" + std::to_string(lo) + ", " +
                                      std::to_string(hi) + "]");
  return static_cast<int>(v.get<int64_t>());
}
double num(const json &c, const char *k, double lo, double hi) {
  const json &v = c.at(k);
  if (!v.is_number() || !std::isfinite(v.get<double>()) || v.get<double>() < lo || v.get<double>() > hi)
    throw CmdError("bad_request", std::string(k) + " must be a number in [" + std::to_string(lo) + ", " +
                                      std::to_string(hi) + "]");
  return v.get<double>();
}
bool flag(const json &c, const char *k) {
  if (!c.at(k).is_boolean())
    throw CmdError("bad_request", std::string(k) + " must be true or false");
  return c.at(k).get<bool>();
}
int paths_from(const json &c) {
  const json &v = c.at("paths");
  const std::string s = v.is_string() ? v.get<std::string>() : "";
  if (s == "a") return 1;
  if (s == "b") return 2;
  if (s == "ab") return 3;
  throw CmdError("bad_request", "paths must be \"a\", \"b\" or \"ab\"");
}
const char *paths_name(int p) { return p == 2 ? "b" : p == 3 ? "ab" : "a"; }
} // namespace

Engine::Engine(Callbacks cb, std::string record_dir) : _cb(std::move(cb)), _rec(std::move(record_dir)) {
  _cmd = std::thread([this] { cmd_loop(); });
  _dsp = std::thread([this] { dsp_loop(); });
}

Engine::~Engine() {
  {
    std::lock_guard<std::mutex> l(_qm);
    _quit = true;
  }
  _qcv.notify_all();
  if (_cmd.joinable())
    _cmd.join();
  close_adapter(); // stops the recorder and the stream; the DSP thread then idles
  _dsp_quit = true;
  _ring.wake();
  if (_dsp.joinable())
    _dsp.join();
}

void Engine::submit(json cmd, std::function<void(const json &)> reply) {
  {
    std::lock_guard<std::mutex> l(_qm);
    _q.emplace_back(std::move(cmd), std::move(reply));
  }
  _qcv.notify_one();
}

void Engine::poll() {
  const auto r = rx();
  if (!r)
    return;
  // Fatal only when the worker has ended (a retune error is retried and passes).
  const wsdr::RxStatus st = r->status();
  if (!st.running && (st.state == wsdr::RxState::Lost || st.state == wsdr::RxState::Error) &&
      !_lost_requested.exchange(true))
    submit({{"cmd", "_lost"}}, nullptr);
}

void Engine::cmd_loop() {
  for (;;) {
    std::pair<json, std::function<void(const json &)>> item;
    {
      std::unique_lock<std::mutex> l(_qm);
      _qcv.wait(l, [&] { return !_q.empty() || _quit; });
      if (_quit)
        return;
      item = std::move(_q.front());
      _q.pop_front();
    }
    const json &c = item.first;
    json r;
    try {
      r = run(c);
      r["type"] = "ack";
    } catch (const CmdError &e) {
      r = {{"type", "error"}, {"kind", e.kind}, {"msg", e.what()}};
    } catch (const json::exception &e) {
      r = {{"type", "error"}, {"kind", "bad_request"}, {"msg", e.what()}};
    } catch (const std::exception &e) {
      r = {{"type", "error"}, {"kind", "other"}, {"msg", e.what()}};
    }
    if (c.contains("id"))
      r["id"] = c["id"];
    if (c.contains("cmd"))
      r["cmd"] = c["cmd"];
    if (item.second)
      item.second(r);
  }
}

json Engine::run(const json &c) {
  if (!c.contains("cmd") || !c["cmd"].is_string())
    throw CmdError("bad_request", "missing cmd");
  const std::string cmd = c["cmd"].get<std::string>();
  if (cmd == "scan") {
    json d = devices_json(scan_devices());
    _cb.event(d);
    return {{"devices", d["devices"]}};
  }
  if (cmd == "open") {
    open_adapter(static_cast<uint16_t>(integer(c, "pid", 0, 65535)), c);
    return {};
  }
  if (cmd == "close") {
    close_adapter();
    _cb.event(caps());
    return {};
  }
  if (cmd == "set") {
    const auto r = rx();
    if (!r || !r->is_open())
      throw CmdError("closed", "no adapter open");
    wsdr::RxSettings s = r->settings();
    if (c.contains("freq"))
      s.freq = num(c, "freq", 2.3e9, 6.2e9);
    if (c.contains("rate_sel"))
      s.rate_sel = integer(c, "rate_sel", 1, 5);
    if (c.contains("wide"))
      s.wide = flag(c, "wide");
    if (c.contains("agc"))
      s.agc = flag(c, "agc");
    if (c.contains("gain_db"))
      s.gain_db = num(c, "gain_db", 0, 100);
    r->set(s);
    _cb.event(settings());
    return {};
  }
  if (cmd == "dsp") {
    DspConfig n;
    {
      std::lock_guard<std::mutex> l(_dm);
      n = _dsp_cfg;
    }
    // validate everything first, then apply
    if (c.contains("fft")) {
      n.fft = integer(c, "fft", 1024, 16384);
      if (n.fft & (n.fft - 1))
        throw CmdError("bad_request", "fft must be a power of two");
    }
    if (c.contains("rows_per_s"))
      n.rows_per_s = num(c, "rows_per_s", 1, 30);
    if (c.contains("paths")) {
      n.paths = paths_from(c);
      std::lock_guard<std::mutex> l(_sm);
      if (n.paths != 1 && _caps.paths < 2)
        throw CmdError("bad_request", "this adapter has one receive path (A)");
    }
    if (c.contains("dc_remove"))
      n.dc_remove = flag(c, "dc_remove");
    {
      std::lock_guard<std::mutex> l(_dm);
      _dsp_cfg = n;
      _dsp_dirty = true;
    }
    _cb.event(settings());
    return {};
  }
  if (cmd == "record") {
    const std::string a = c.value("action", "");
    if (a == "stop") {
      const std::string file = _rec.info().path;
      stop_recording("");
      return {{"file", file}};
    }
    if (a != "start")
      throw CmdError("bad_request", "record action must be start or stop");
    const auto r = rx();
    if (!r || !r->is_open())
      throw CmdError("closed", "no adapter open");
    if (_rec.info().active)
      throw CmdError("busy", "already recording");
    const wsdr::RxStatus st = r->status();
    if (st.state != wsdr::RxState::Streaming)
      throw CmdError("not_streaming", "not streaming");
    if (st.settling)
      throw CmdError("busy", "settings are being applied; try again in a moment");
    const wsdr::RxSettings s = r->settings();
    int path;
    {
      std::lock_guard<std::mutex> l(_dm);
      path = _dsp_cfg.paths == 2 ? 1 : 0; // B only when B alone is shown; A otherwise
    }
    std::string adapter;
    {
      std::lock_guard<std::mutex> l(_sm);
      adapter = _adapter;
    }
    _recording = false;
    const std::string file = _rec.start(st.fs, st.centre_hz, adapter, path, s.gain_db, s.agc);
    _rec_path = path;
    _rec_gen = st.gen; // only banks of this run (centre/fs as in st) go into the file
    _rec_cfg = st.cfg;
    _rec_id++;
    _rec_stop_requested = false;
    _recording = true;
    _cb.event(status());
    return {{"file", file}};
  }
  if (cmd == "_rec_stop") { // from the DSP thread; ignore requests about an earlier recording
    if (c.value("rec", uint64_t{0}) == _rec_id.load())
      stop_recording(c.value("reason", ""));
    return {};
  }
  if (cmd == "_lost") { // from poll(); re-check: the user may have pressed Stop meanwhile
    const auto r = rx();
    const wsdr::RxStatus st = r ? r->status() : wsdr::RxStatus{};
    _lost_requested = false;
    if (!r || st.running || (st.state != wsdr::RxState::Lost && st.state != wsdr::RxState::Error))
      return {};
    _lost_requested = true;
    const bool lost = st.state == wsdr::RxState::Lost;
    stop_recording(lost ? "adapter disconnected" : "stream failed");
    close_adapter();
    {
      std::lock_guard<std::mutex> l(_sm);
      _error = lost ? "Adapter disconnected. Plug it back in, then press Start."
                    : "The stream kept failing (" + st.error + "). Press Start to try again.";
    }
    _cb.event(caps());
    _cb.event({{"type", "alert"}, {"msg", lost ? "Adapter disconnected. Plug it back in, then press Start."
                                                : "The stream kept failing. Press Start to try again."}});
    _cb.event(devices_json(scan_devices()));
    return {};
  }
  throw CmdError("bad_request", "unknown command '" + cmd + "'");
}

void Engine::stop_recording(const std::string &why) {
  _recording = false;
  if (!_rec.stop())
    return; // nothing was recording
  const RecordInfo ri = _rec.info();
  json e = {{"type", "recorded"}, {"file", ri.path}, {"samples", ri.samples},
            {"seconds", ri.fs > 0 ? ri.samples / ri.fs : 0.0}, {"bytes", ri.samples * 4}};
  if (!why.empty())
    e["reason"] = why;
  if (!ri.error.empty())
    e["error"] = ri.error;
  _cb.event(e);
  _cb.event(status());
}

void Engine::open_adapter(uint16_t pid, const json &c) {
  if (pid != wsdr::kPid8812bu && pid != wsdr::kPid8812cu)
    throw CmdError("bad_request", "pid must be 0xb812 or 0xc812");
  close_adapter();
  wsdr::RxSettings s;
  s.freq = c.contains("freq") ? num(c, "freq", 2.3e9, 6.2e9) : 5180e6;
  s.rate_sel = c.contains("rate_sel") ? integer(c, "rate_sel", 1, 5) : (pid == wsdr::kPid8812cu ? 4 : 2);
  const int bus = c.contains("bus") ? integer(c, "bus", 0, 255) : -1;
  std::string port;
  if (c.contains("port")) {
    if (!c["port"].is_string() || c["port"].get<std::string>().size() > 32)
      throw CmdError("bad_request", "port must be a string like \"1\" or \"1.2\"");
    port = c["port"].get<std::string>();
  }
  s.gain_db = c.contains("gain_db") ? num(c, "gain_db", 0, 100) : 30.0;
  s.agc = c.contains("agc") ? flag(c, "agc") : false;
  s.wide = c.contains("wide") ? flag(c, "wide") : true;
  {
    std::lock_guard<std::mutex> l(_sm);
    _state = "opening";
    _error.clear();
  }
  _cb.event(status());
  auto r = std::make_shared<wsdr::Receiver>(std::make_shared<Logger>());
  try {
    r->open(pid, s, bus, port);
  } catch (const wsdr::OpenError &e) {
    std::lock_guard<std::mutex> l(_sm);
    _state = "closed";
    _error = e.what();
    throw CmdError(open_kind(e.kind), e.what());
  } catch (const std::exception &e) {
    std::lock_guard<std::mutex> l(_sm);
    _state = "closed";
    _error = std::string("bring-up failed: ") + e.what();
    throw CmdError("bringup", _error);
  }
  {
    std::lock_guard<std::mutex> l(_dm);
    if (r->caps().paths < 2)
      _dsp_cfg.paths = 1; // path B exists on the 8812CU only
    _dsp_dirty = true;
  }
  _ring.clear();
  _lost_requested = false;
  r->start([this](const uint8_t *b, size_t n, const wsdr::BankMeta &m) { _ring.push(b, n, m); });
  {
    std::lock_guard<std::mutex> l(_sm);
    _caps = r->caps();
    _adapter = (_caps.cu ? std::string("RTL8812CU (") : std::string("RTL8812BU (")) + _caps.chip + ")";
    _state = "open";
  }
  {
    std::lock_guard<std::mutex> l(_rxm);
    _rx = std::move(r);
  }
  _cb.event(caps());
  _cb.event(settings());
}

void Engine::close_adapter() {
  stop_recording("");
  std::shared_ptr<wsdr::Receiver> old;
  {
    std::lock_guard<std::mutex> l(_rxm);
    old.swap(_rx);
  }
  if (old)
    old->close();
  _ring.clear();
  std::lock_guard<std::mutex> l(_sm);
  _state = "closed";
  _caps = {};
}

json Engine::settings() const {
  json j = {{"type", "settings"}};
  if (const auto r = rx(); r && r->is_open()) {
    const wsdr::RxSettings s = r->settings();
    j["rx"] = {{"freq", s.freq}, {"rate_sel", s.rate_sel}, {"wide", s.wide}, {"agc", s.agc}, {"gain_db", s.gain_db}};
  }
  std::lock_guard<std::mutex> l(_dm);
  j["dsp"] = {{"fft", _dsp_cfg.fft}, {"rows_per_s", _dsp_cfg.rows_per_s}, {"paths", paths_name(_dsp_cfg.paths)},
              {"dc_remove", _dsp_cfg.dc_remove}};
  return j;
}

json Engine::caps() const {
  const bool open = rx() != nullptr;
  std::lock_guard<std::mutex> l(_sm);
  json j = {{"type", "caps"}, {"open", open}};
  if (open) {
    json rates = json::array();
    for (int r = 5; r >= _caps.min_rate_sel; r--)
      rates.push_back({{"rate_sel", r}, {"fs", wsdr::Receiver::rate_of(r)}});
    j["adapter"] = _adapter;
    j["pid"] = _caps.pid;
    j["chip"] = _caps.chip;
    j["superspeed"] = _caps.superspeed;
    j["paths"] = _caps.paths;
    j["rates"] = rates;
    j["gain_max"] = _caps.gain_max;
    j["gain_step"] = _caps.gain_step;
    j["wide_capable"] = !_caps.cu && _caps.min_rate_sel <= 1;
  }
  return j;
}

json Engine::status() const {
  json j = {{"type", "status"}};
  {
    std::lock_guard<std::mutex> l(_sm);
    j["state"] = _state;
    j["adapter"] = _adapter;
    j["error"] = _error;
  }
  if (const auto r = rx(); r && r->is_open()) {
    const wsdr::RxStatus st = r->status();
    j["rx"] = {{"state", wsdr::rx_state_name(st.state)}, {"banks", st.banks}, {"restarts", st.restarts},
               {"channel", st.channel}, {"width", st.width}, {"centre", st.centre_hz}, {"fs", st.fs},
               {"error", st.error}};
  }
  j["ring_dropped"] = _ring.dropped();
  j["rows"] = _rows.load();
  j["dsp_load"] = _dsp_load.load();
  const RecordInfo ri = _rec.info();
  j["record"] = {{"active", ri.active}, {"file", ri.path}, {"samples", ri.samples},
                 {"seconds", ri.fs > 0 ? ri.samples / ri.fs : 0.0}, {"bytes", ri.samples * 4}, {"error", ri.error}};
  // free space where recordings go (the nearest existing directory)
  std::error_code ec;
  std::filesystem::path d = _rec.dir();
  while (!d.empty() && !std::filesystem::exists(d, ec) && d.has_parent_path() && d != d.parent_path())
    d = d.parent_path();
  struct statvfs v {};
  if (statvfs(d.c_str(), &v) == 0)
    j["disk_free"] = static_cast<double>(v.f_bavail) * v.f_frsize;
  j["t"] = now_s();
  return j;
}

json Engine::devices_json(const std::vector<DeviceInfo> &d) {
  json arr = json::array();
  for (const auto &x : d)
    arr.push_back({{"pid", x.pid}, {"model", x.model}, {"chip", x.chip}, {"bus", x.bus}, {"port", x.port},
                   {"speed_mbps", x.speed_mbps}, {"controller", x.controller}, {"driver", x.driver},
                   {"can_open", x.can_open}, {"max_msps", x.max_msps}});
  return {{"type", "devices"}, {"devices", arr}};
}

void Engine::dsp_loop() {
  Spectrum sp;
  uint32_t gen = ~0u, cfg = ~0u;
  std::vector<int16_t> iq(2 * 8192);
  std::vector<wsdr::cf> tmp(8192);
  double busy = 0;
  auto win = clk::now();
  // Ask the command thread to stop the recording (once); stop feeding it right away.
  uint64_t rec_seen = 0; // the recording rec_next belongs to
  auto request_stop = [&](const char *reason) {
    _recording = false;
    if (!_rec_stop_requested.exchange(true))
      submit({{"cmd", "_rec_stop"}, {"reason", reason}, {"rec", rec_seen}}, nullptr); // the file the bank was checked for
  };
  uint64_t rec_next = 0; // next bank seq expected in the file (0 = not started)
  while (!_dsp_quit) {
    Bank *b = _ring.pop(std::chrono::milliseconds(100));
    const auto t0 = clk::now();
    if (b) {
      {
        std::lock_guard<std::mutex> l(_dm);
        if (_dsp_dirty) {
          sp.configure(_dsp_cfg);
          _dsp_dirty = false;
        }
      }
      gen = b->meta.gen;
      cfg = b->meta.cfg;
      sp.process(b->data.data(), b->bytes, b->meta, [&](const Row &r) {
        _rows++;
        _cb.row(encode_row(r, now_s()));
      });
      // Every file has one centre, one rate and no gaps. Banks of the run the recording belongs to go
      // in; older ones (still queued from before a retune) are skipped; a newer run, or a gap in the
      // bank sequence (the DSP fell behind and the ring dropped banks), ends the file.
      if (_rec_id != rec_seen) { // a new recording: its first bank starts the sequence
        rec_seen = _rec_id;
        rec_next = 0;
      }
      if (!_recording) {
        rec_next = 0;
      } else if (gen > _rec_gen) {
        request_stop(cfg != _rec_cfg ? "settings changed" : "the stream restarted after a fault");
      } else if (gen == _rec_gen && rec_next && b->meta.seq != rec_next) {
        request_stop("samples were lost (the computer could not keep up); the file ends before the gap");
      } else if (gen == _rec_gen) {
        rec_next = b->meta.seq + 1;
        const int path = b->meta.paths > 1 ? _rec_path.load() : 0;
        const size_t ns = b->bytes / 8;
        Spectrum::unpack(b->data.data(), ns, path, tmp.data());
        for (size_t i = 0; i < ns; i++) {
          iq[2 * i] = static_cast<int16_t>(static_cast<int>(tmp[i].real()) * 16);
          iq[2 * i + 1] = static_cast<int16_t>(static_cast<int>(tmp[i].imag()) * 16);
        }
        _rec.push(iq.data(), ns);
        if (_rec.failed())
          request_stop("the recording could not be written");
        else if (_rec.dropped())
          request_stop("the disk could not keep up; the file ends before the first lost sample");
      }
      _ring.release(b);
      busy += std::chrono::duration<double>(clk::now() - t0).count();
    }
    const double el = std::chrono::duration<double>(clk::now() - win).count();
    if (el >= 1.0) {
      _dsp_load = busy / el;
      busy = 0;
      win = clk::now();
    }
  }
}

} // namespace studio
