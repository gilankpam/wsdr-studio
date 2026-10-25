// SPDX-License-Identifier: GPL-2.0-only
// HTTP + WebSocket server (Boost.Beast, one I/O thread) for the web UI.
//
// Security model: local only. Binds 127.0.0.1. Every request must carry Host 127.0.0.1:PORT or
// localhost:PORT (DNS rebinding). The WebSocket /ws needs the session token as ?t=TOKEN plus, when a
// browser sends one, an Origin from the same two hosts (cross-site WebSocket). The token never appears
// on a command line: the browser is started on /#k=KEY (a single-use launch key, valid 30 s, in the URL
// fragment, which browsers never send to a server); the page exchanges it once via /api/session?k=KEY
// and keeps the token in sessionStorage, which is per origin (port included) and per tab. No cookies:
// those would be shared with every other service on 127.0.0.1. /api/launch-key?t=TOKEN mints a new
// key (a second launch opens a window that way). Static files come from one directory, canonicalised.
//
// Thread safety: broadcast_* and send_text may be called from any thread; they post to the I/O thread.
// Each client has a bounded queue of binary frames: a slow client loses rows, nobody blocks.
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include <boost/asio/io_context.hpp>

namespace studio {

class WsClient;

struct ServerOptions {
  uint16_t port = 8073;
  std::string token;
  std::string webroot;
  std::vector<std::string> extra_origins; // e.g. the Vite dev server
};

class Server {
public:
  using ClientPtr = std::shared_ptr<WsClient>;
  struct Handlers {
    std::function<void(const ClientPtr &)> on_open;
    std::function<void(const ClientPtr &, const std::string &text)> on_text;
  };
  Server(boost::asio::io_context &io, ServerOptions o, Handlers h);
  ~Server();
  // Bind and start accepting. false + err if the port is taken.
  bool listen(std::string &err);
  uint16_t port() const { return _o.port; }

  // A single-use key for /?k=KEY (thread-safe).
  std::string new_launch_key();
  bool consume_launch_key(const std::string &k);

  void broadcast_binary(std::vector<uint8_t> &&frame);
  void broadcast_text(std::string text);
  void send_text(const std::weak_ptr<WsClient> &c, std::string text);
  size_t clients() const { return _nclients; }
  uint64_t frames_dropped() const { return _dropped; }

  // used by the session classes
  const ServerOptions &options() const { return _o; }
  const Handlers &handlers() const { return _h; }
  void add(const ClientPtr &c);
  void accept_next();
  void remove(const ClientPtr &c);
  void count_drop() { _dropped++; }

private:
  struct Impl;
  boost::asio::io_context &_io;
  ServerOptions _o;
  Handlers _h;
  std::unique_ptr<Impl> _impl;
  std::mutex _cm;
  std::set<ClientPtr> _clients;
  std::mutex _km;
  std::vector<std::pair<std::string, std::chrono::steady_clock::time_point>> _keys;
  std::atomic<size_t> _nclients{0};
  std::atomic<uint64_t> _dropped{0};
};

} // namespace studio
