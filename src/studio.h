// SPDX-License-Identifier: GPL-2.0-only
// Studio: the app's two view slots (A = 0, B = 1), each an Engine owning at most one adapter, behind
// protocol v1 (protocol.h) with no transport of its own. The native backend puts it behind the
// WebSocket server (main.cpp); the web build behind a worker's postMessage (wasm/core.cpp).
//
// Commands name their slot ("slot", default 0); events carry it, except "devices" (everyone's); row
// frames carry it in the path byte (bit 4). Commands starting with '_' are the engines' own.
//
// Thread safety: client_open / client_text / tick may be called from any one thread; the Out
// callbacks are called from the engines' threads and must not block.
#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"

namespace studio {

class Studio {
public:
  static constexpr int kSlots = 2;
  using Send = std::function<void(std::string text)>;
  struct Out {
    Send broadcast_text;                                          // to every client
    std::function<void(std::vector<uint8_t> &&)> broadcast_binary; // row frames, to every client
  };
  Studio(Out out, std::string record_dir, bool usb3_default, std::string home);
  ~Studio();

  // A client connected: hello, then each slot's caps / settings / status (and a scan, whose "devices"
  // goes to everyone).
  void client_open(const Send &send);
  // One text frame from a client: a command, answered through reply (ack / error, with its id).
  void client_text(const std::string &text, const Send &reply);
  // 2 Hz: notice unplugged adapters; status to everyone while anyone listens.
  void tick(bool any_clients, uint64_t client_drops);
  Engine &engine(int slot) { return *_engs[slot]; }

private:
  Out _out;
  std::string _home;
  std::array<std::unique_ptr<Engine>, kSlots> _engs;
};

} // namespace studio
