// SPDX-License-Identifier: GPL-2.0-only
#include "engine.h"

#include <chrono>
#include <cmath>
#include <cstring>

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

int paths_from(const std::string &s) { return s == "b" ? 2 : s == "ab" ? 3 : 1; }
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
  close_adapter();
  _dsp_quit = true;
  _ring.wake();
  if (_dsp.joinable())
    _dsp.join();
  _rec.stop();
}

void Engine::submit(json cmd, std::function<void(const json &)> reply) {
  {
    std::lock_guard<std::mutex> l(_qm);
    _q.emplace_back(std::move(cmd), std::move(reply));
  }
  _qcv.notify_one();
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
  const std::string cmd = c.value("cmd", "");
  if (cmd == "scan") {
    json d = devices_json(scan_devices());
    _cb.event(d);
    return {{"devices", d["devices"]}};
  }
  if (cmd == "open") {
    open_adapter(static_cast<uint16_t>(c.value("pid", 0)), c);
    return {};
  }
  if (cmd == "close") {
    close_adapter();
    _cb.event(caps());
    return {};
  }
  if (cmd == "set") {
    const auto rxp = rx();
    if (!rxp || !rxp->is_open())
      throw CmdError("closed", "no adapter open");
    wsdr::RxSettings s = rxp->settings();
    if (c.contains("freq"))
      s.freq = c["freq"].get<double>();
    if (c.contains("rate_sel"))
      s.rate_sel = c["rate_sel"].get<int>();
    if (c.contains("wide"))
      s.wide = c["wide"].get<bool>();
    if (c.contains("agc"))
      s.agc = c["agc"].get<bool>();
    if (c.contains("gain_db"))
      s.gain_db = c["gain_db"].get<double>();
    if (s.freq < 2.3e9 || s.freq > 6.2e9)
      throw CmdError("range", "frequency out of range (2.3-6.2 GHz)");
    rxp->set(s);
    publish_settings();
    return {};
  }
  if (cmd == "dsp") {
    {
      std::lock_guard<std::mutex> l(_dm);
      if (c.contains("fft"))
        _dsp_cfg.fft = c["fft"].get<int>();
      if (c.contains("rows_per_s"))
        _dsp_cfg.rows_per_s = c["rows_per_s"].get<double>();
      if (c.contains("paths"))
        _dsp_cfg.paths = paths_from(c["paths"].get<std::string>());
      if (c.contains("dc_remove"))
        _dsp_cfg.dc_remove = c["dc_remove"].get<bool>();
      _dsp_dirty = true;
    }
    publish_settings();
    return {};
  }
  if (cmd == "record") {
    const std::string a = c.value("action", "");
    if (a == "stop") {
      _record_req = false;
      _rec.stop();
      _cb.event(status());
      return {{"file", _rec.info().path}};
    }
    if (a != "start")
      throw CmdError("bad_request", "record action must be start or stop");
    const auto rxp = rx();
    if (!rxp || !rxp->is_open())
      throw CmdError("closed", "no adapter open");
    const wsdr::RxStatus st = rxp->status();
    if (st.state != wsdr::RxState::Streaming)
      throw CmdError("not_streaming", "not streaming");
    const wsdr::RxSettings s = rxp->settings();
    int path;
    {
      std::lock_guard<std::mutex> l(_dm);
      path = _dsp_cfg.paths == 2 ? 1 : 0;
    }
    std::string file;
    {
      std::lock_guard<std::mutex> l(_sm);
      file = _rec.start(st.fs, st.centre_hz, _adapter, path, s.gain_db, s.agc);
    }
    _record_req = true;
    _cb.event(status());
    return {{"file", file}};
  }
  throw CmdError("bad_request", "unknown command '" + cmd + "'");
}

void Engine::open_adapter(uint16_t pid, const json &c) {
  if (pid != wsdr::kPid8812bu && pid != wsdr::kPid8812cu)
    throw CmdError("bad_request", "pid must be 0xb812 or 0xc812");
  close_adapter();
  wsdr::RxSettings s;
  s.freq = c.value("freq", 5180e6);
  s.rate_sel = c.value("rate_sel", pid == wsdr::kPid8812cu ? 4 : 2);
  s.gain_db = c.value("gain_db", 30.0);
  s.agc = c.value("agc", false);
  {
    std::lock_guard<std::mutex> l(_sm);
    _state = "opening";
    _error.clear();
  }
  _cb.event(status());
  auto rx = std::make_shared<wsdr::Receiver>(std::make_shared<Logger>());
  try {
    rx->open(pid, s);
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
    if (rx->caps().paths < 2)
      _dsp_cfg.paths = 1; // path B exists on the 8812CU only
    _dsp_dirty = true;
  }
  _ring.clear();
  rx->start([this](const uint8_t *b, size_t n, const wsdr::BankMeta &m) { _ring.push(b, n, m); });
  {
    std::lock_guard<std::mutex> l(_sm);
    _caps = rx->caps();
    _adapter = (_caps.cu ? std::string("RTL8812CU (") : std::string("RTL8812BU (")) + _caps.chip + ")";
    _open = true;
    _state = "open";
  }
  {
    std::lock_guard<std::mutex> l(_rxm);
    _rx = std::move(rx);
  }
  _cb.event(caps());
  publish_settings();
}

void Engine::close_adapter() {
  _record_req = false;
  _rec.stop();
  std::shared_ptr<wsdr::Receiver> old;
  {
    std::lock_guard<std::mutex> l(_rxm);
    old.swap(_rx);
  }
  if (old)
    old->close();
  _ring.clear();
  std::lock_guard<std::mutex> l(_sm);
  _open = false;
  _state = "closed";
  _caps = {};
}

void Engine::publish_settings() { _cb.event(settings()); }

json Engine::settings() const {
  json j = {{"type", "settings"}};
  if (const auto rxp = rx(); rxp && rxp->is_open()) {
    const wsdr::RxSettings s = rxp->settings();
    j["rx"] = {{"freq", s.freq}, {"rate_sel", s.rate_sel}, {"wide", s.wide}, {"agc", s.agc}, {"gain_db", s.gain_db}};
  }
  std::lock_guard<std::mutex> l(_dm);
  j["dsp"] = {{"fft", _dsp_cfg.fft}, {"rows_per_s", _dsp_cfg.rows_per_s}, {"paths", paths_name(_dsp_cfg.paths)},
              {"dc_remove", _dsp_cfg.dc_remove}};
  return j;
}

json Engine::caps() const {
  std::lock_guard<std::mutex> l(_sm);
  json j = {{"type", "caps"}, {"open", _open}};
  if (_open) {
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
  if (const auto rxp = rx(); rxp && rxp->is_open()) {
    const wsdr::RxStatus st = rxp->status();
    j["rx"] = {{"state", wsdr::rx_state_name(st.state)}, {"banks", st.banks}, {"restarts", st.restarts},
               {"channel", st.channel}, {"width", st.width}, {"centre", st.centre_hz}, {"fs", st.fs},
               {"error", st.error}};
    if (st.state == wsdr::RxState::Lost || st.state == wsdr::RxState::Error)
      j["state"] = wsdr::rx_state_name(st.state);
  }
  j["ring_dropped"] = _ring.dropped();
  j["rows"] = _rows.load();
  j["dsp_load"] = _dsp_load.load();
  const RecordInfo ri = _rec.info();
  j["record"] = {{"active", ri.active}, {"file", ri.path}, {"samples", ri.samples}, {"dropped", ri.dropped},
                 {"seconds", ri.fs > 0 ? ri.samples / ri.fs : 0.0}};
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
  uint32_t gen = ~0u;
  std::vector<int16_t> iq(2 * 8192);
  std::vector<wsdr::cf> tmp(8192);
  double busy = 0;
  auto win = clk::now();
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
      if (b->meta.gen != gen) {
        gen = b->meta.gen;
        _rec_gen = gen;
        if (_rec.active() && _record_req) {
          // A retune or rate change ends the recording: one file, one centre, one rate.
          _record_req = false;
          _rec.stop();
          _cb.event({{"type", "notice"}, {"msg", "recording stopped: settings changed"}});
        }
      }
      sp.process(b->data.data(), b->bytes, b->meta, [&](const Row &r) {
        _rows++;
        _cb.row(encode_row(r, now_s()));
      });
      if (_record_req && _rec.active()) {
        const int path = sp.config().paths == 2 && b->meta.paths > 1 ? 1 : 0;
        const size_t ns = b->bytes / 8;
        Spectrum::unpack(b->data.data(), ns, path, tmp.data());
        for (size_t i = 0; i < ns; i++) {
          iq[2 * i] = static_cast<int16_t>(static_cast<int>(tmp[i].real()) * 16);
          iq[2 * i + 1] = static_cast<int16_t>(static_cast<int>(tmp[i].imag()) * 16);
        }
        _rec.push(iq.data(), ns);
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
