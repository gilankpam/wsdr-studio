// SPDX-License-Identifier: GPL-2.0-only
#include "studio.h"

namespace studio {

namespace {
std::string tagged(json e, int slot) {
  e["slot"] = slot;
  return e.dump(-1, ' ', false, json::error_handler_t::replace); // (never throw on bad UTF-8)
}

json bad_request(const json &cmd, const char *msg) {
  json e = {{"type", "error"}, {"kind", "bad_request"}, {"msg", msg}};
  if (cmd.is_object() && cmd.contains("id"))
    e["id"] = cmd["id"];
  return e;
}
} // namespace

Studio::Studio(Out out, std::string record_dir, bool usb3_default, std::string home)
    : _out(std::move(out)), _home(std::move(home)) {
  const auto claims = std::make_shared<Claims>();
  for (int i = 0; i < kSlots; i++) {
    _engs[i] = std::make_unique<Engine>(
        Engine::Callbacks{[this, i](std::vector<uint8_t> &&f) {
                            if (i && f.size() > 6)
                              f[6] |= 0x10; // slot B
                            _out.broadcast_binary(std::move(f));
                          },
                          [this, i](const json &e) {
                            // the adapter list is everyone's; the rest is this slot's
                            _out.broadcast_text(e.value("type", "") == "devices" ? e.dump() : tagged(e, i));
                          }},
        record_dir, i, claims);
    _engs[i]->set_usb3_default(usb3_default); // also for Start pressed in the app
  }
}

Studio::~Studio() {
  for (auto &e : _engs)
    e.reset(); // closes the adapters (and finalises a recording) before the callbacks' owner goes
}

void Studio::client_open(const Send &send) {
  send(json{{"type", "hello"}, {"version", 1}, {"app", "wsdr-studio"}, {"home", _home}, {"slots", kSlots}}.dump());
  _engs[0]->submit({{"cmd", "scan"}}, nullptr); // broadcasts "devices"; USB enumeration stays off this thread
  for (int i = 0; i < kSlots; i++) {
    send(tagged(_engs[i]->caps(), i));
    send(tagged(_engs[i]->settings(), i));
    send(tagged(_engs[i]->status(), i));
  }
}

void Studio::client_text(const std::string &text, const Send &reply) {
  json cmd = json::parse(text, nullptr, false);
  if (cmd.is_discarded() || !cmd.is_object())
    return reply(bad_request(json(), "not a JSON object").dump());
  if (cmd.contains("cmd") && cmd["cmd"].is_string() && cmd["cmd"].get<std::string>().rfind('_', 0) == 0)
    return reply(bad_request(cmd, "unknown command").dump()); // internal commands (_lost, _rec_stop) are the engine's own
  int slot = 0;
  if (cmd.contains("slot")) {
    if (!cmd["slot"].is_number_integer() || cmd["slot"].get<int>() < 0 || cmd["slot"].get<int>() >= kSlots)
      return reply(bad_request(cmd, "slot must be 0 or 1").dump());
    slot = cmd["slot"].get<int>();
  }
  // (a reply may carry a path with bytes that are not UTF-8: replaced, never thrown on)
  _engs[slot]->submit(std::move(cmd), [reply](const json &r) { reply(r.dump(-1, ' ', false, json::error_handler_t::replace)); });
}

void Studio::tick(bool any_clients, uint64_t client_drops) {
  for (int i = 0; i < kSlots; i++) {
    _engs[i]->poll(); // notices an unplugged adapter
    if (any_clients) {
      json st = _engs[i]->status();
      st["client_drops"] = client_drops;
      _out.broadcast_text(tagged(st, i));
    }
  }
}

} // namespace studio
