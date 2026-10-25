// SPDX-License-Identifier: GPL-2.0-only
// wsdr-studiod — the wsdr-studio backend: owns the adapter (via wifi-sdr/devourer), computes the
// spectrum and serves the web UI on http://127.0.0.1:PORT/?t=TOKEN, opened as a Chrome app window.
//
//   wsdr-studiod [--port 8073] [--no-browser] [--web DIR] [--pid 0xb812] [--freq 5190e6] [--rate 40]
//                [--record-dir DIR] [--dev-origin http://localhost:5173]
//   wsdr-studiod --headless-seconds 20 --pid 0xb812 [--freq ..] [--rate ..] [--fft 8192]
//       engine + DSP only (no server, no browser); prints status JSON each second and a summary.
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <boost/asio/io_context.hpp>
#include <boost/asio/signal_set.hpp>
#include <boost/asio/steady_timer.hpp>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "engine.h"
#include "server.h"

using namespace studio;
namespace fs = std::filesystem;
namespace net = boost::asio;
extern char **environ;

namespace {

struct Args {
  uint16_t port = 8073;
  bool browser = true;
  std::string web, record_dir;
  std::vector<std::string> dev_origins;
  uint16_t pid = 0;
  double freq = 0, rate_msps = 0, headless = 0;
  int fft = 0;
};

int rate_sel_for(double msps) {
  int best = 5;
  for (int r = 1; r <= 5; r++)
    if (std::abs(80.0 / (1 << r) - msps) < std::abs(80.0 / (1 << best) - msps))
      best = r;
  return best;
}

std::string random_token() {
  std::random_device rd;
  char b[33];
  for (int i = 0; i < 16; i++)
    std::snprintf(b + 2 * i, 3, "%02x", rd() & 0xff);
  return b;
}

std::string exe_dir() {
  std::error_code ec;
  return fs::read_symlink("/proc/self/exe", ec).parent_path().string();
}

std::string default_webroot() {
  for (const fs::path &p : {fs::path(exe_dir()) / "../share/wsdr-studio/web", fs::path(WSDR_STUDIO_SOURCE_DIR) / "web/dist"}) {
    std::error_code ec;
    if (fs::exists(p / "index.html", ec))
      return fs::weakly_canonical(p, ec).string();
  }
  return (fs::path(WSDR_STUDIO_SOURCE_DIR) / "web/dist").string();
}

std::string data_dir() {
  const char *x = std::getenv("XDG_DATA_HOME");
  const char *h = std::getenv("HOME");
  return x && *x ? std::string(x) + "/wsdr-studio" : std::string(h ? h : "/tmp") + "/.local/share/wsdr-studio";
}

std::string instance_file() {
  const char *r = std::getenv("XDG_RUNTIME_DIR");
  return std::string(r && *r ? r : "/tmp") + "/wsdr-studio-" + std::to_string(getuid()) + ".url";
}

// Open the UI: Chrome/Chromium as an app window, else the default browser. The child gets a clean
// environment for libraries (an AppImage's LD_LIBRARY_PATH must not leak into the browser).
void open_browser(const std::string &url) {
  std::vector<std::string> env;
  for (char **e = environ; *e; e++) {
    const std::string s = *e;
    if (s.rfind("LD_LIBRARY_PATH=", 0) == 0 || s.rfind("LD_PRELOAD=", 0) == 0 || s.rfind("APPDIR=", 0) == 0 ||
        s.rfind("APPIMAGE=", 0) == 0 || s.rfind("ARGV0=", 0) == 0)
      continue;
    env.push_back(s);
  }
  std::vector<char *> envp;
  for (auto &s : env)
    envp.push_back(s.data());
  envp.push_back(nullptr);
  const std::string app = "--app=" + url;
  const std::vector<std::vector<std::string>> cmds = {
      {"google-chrome", app}, {"google-chrome-stable", app}, {"chromium", app}, {"chromium-browser", app},
      {"xdg-open", url}};
  for (const auto &c : cmds) {
    std::vector<char *> argv;
    for (const auto &a : c)
      argv.push_back(const_cast<char *>(a.c_str()));
    argv.push_back(nullptr);
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 1, "/dev/null", O_WRONLY, 0);
    posix_spawn_file_actions_addopen(&fa, 2, "/dev/null", O_WRONLY, 0);
    posix_spawnattr_t at;
    posix_spawnattr_init(&at);
    posix_spawnattr_setflags(&at, POSIX_SPAWN_SETSID);
    pid_t pid;
    const int rc = posix_spawnp(&pid, argv[0], &fa, &at, argv.data(), envp.data());
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&at);
    if (rc == 0) {
      std::thread([pid] { waitpid(pid, nullptr, 0); }).detach();
      std::fprintf(stderr, "wsdr-studiod: opened %s with %s\n", url.c_str(), argv[0]);
      return;
    }
  }
  std::fprintf(stderr, "wsdr-studiod: no browser found; open %s\n", url.c_str());
}

bool parse(int argc, char **argv, Args &a) {
  for (int i = 1; i < argc; i++) {
    const std::string k = argv[i];
    auto v = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (k == "--port") a.port = static_cast<uint16_t>(std::stoi(v()));
    else if (k == "--no-browser") a.browser = false;
    else if (k == "--web") a.web = v();
    else if (k == "--record-dir") a.record_dir = v();
    else if (k == "--dev-origin") a.dev_origins.push_back(v());
    else if (k == "--pid") a.pid = static_cast<uint16_t>(std::stoul(v(), nullptr, 0));
    else if (k == "--freq") a.freq = std::stod(v());
    else if (k == "--rate") a.rate_msps = std::stod(v());
    else if (k == "--fft") a.fft = std::stoi(v());
    else if (k == "--headless-seconds") a.headless = std::stod(v());
    else if (k == "-h" || k == "--help") return false;
    else {
      std::fprintf(stderr, "unknown option %s\n", k.c_str());
      return false;
    }
  }
  return true;
}

json open_cmd(const Args &a) {
  json c = {{"cmd", "open"}, {"pid", a.pid}, {"id", 0}};
  if (a.freq > 0)
    c["freq"] = a.freq;
  if (a.rate_msps > 0)
    c["rate_sel"] = rate_sel_for(a.rate_msps);
  return c;
}

int run_headless(const Args &a) {
  if (!a.pid) {
    std::fprintf(stderr, "--headless-seconds needs --pid\n");
    return 2;
  }
  std::atomic<uint64_t> frames{0}, bytes{0};
  Engine eng({[&](std::vector<uint8_t> &&f) { frames++; bytes += f.size(); },
              [&](const json &e) {
                if (e.value("type", "") != "status")
                  std::printf("%s\n", e.dump().c_str());
              }},
             a.record_dir.empty() ? data_dir() + "/recordings" : a.record_dir);
  if (a.fft)
    eng.submit({{"cmd", "dsp"}, {"fft", a.fft}}, nullptr);
  std::atomic<int> open_rc{-1};
  eng.submit(open_cmd(a), [&](const json &r) {
    std::printf("%s\n", r.dump().c_str());
    open_rc = r.value("type", "") == "ack" ? 0 : 1;
  });
  while (open_rc < 0)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  if (open_rc != 0)
    return 3;
  const auto t0 = std::chrono::steady_clock::now();
  uint64_t f0 = 0;
  while (std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count() < a.headless) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    json s = eng.status();
    s["row_frames_per_s"] = frames - f0;
    f0 = frames;
    std::printf("%s\n", s.dump().c_str());
    std::fflush(stdout);
  }
  const json s = eng.status();
  std::printf("{\"ev\":\"headless\",\"rows\":%llu,\"frames\":%llu,\"bytes_per_s\":%.0f,\"ring_dropped\":%llu,"
              "\"dsp_load\":%.3f,\"state\":%s}\n",
              static_cast<unsigned long long>(eng.rows_emitted()), static_cast<unsigned long long>(frames.load()),
              bytes / a.headless, static_cast<unsigned long long>(eng.ring_dropped()), eng.dsp_load(),
              s["state"].dump().c_str());
  return s["state"] == "lost" || s["state"] == "error" ? 1 : 0;
}

} // namespace

int main(int argc, char **argv) {
  Args a;
  if (!parse(argc, argv, a)) {
    std::fprintf(stderr, "usage: wsdr-studiod [--port N] [--no-browser] [--web DIR] [--pid 0xb812|0xc812] [--freq HZ] "
                         "[--rate MSPS] [--record-dir DIR] | --headless-seconds N --pid ...\n");
    return 2;
  }
  if (a.headless > 0)
    return run_headless(a);

  // Single instance: if one is already serving, just open its URL.
  {
    std::ifstream f(instance_file());
    std::string url;
    long pid = 0;
    if (f >> pid >> url && pid > 0 && kill(static_cast<pid_t>(pid), 0) == 0) {
      std::fprintf(stderr, "wsdr-studiod: already running (pid %ld)\n", pid);
      if (a.browser)
        open_browser(url);
      return 0;
    }
  }

  net::io_context io;
  ServerOptions so;
  so.token = random_token();
  so.webroot = a.web.empty() ? default_webroot() : a.web;
  so.extra_origins = a.dev_origins;
  std::unique_ptr<Server> srv;
  std::unique_ptr<Engine> eng;
  Server::Handlers h;
  std::atomic<bool> seen_client{false};
  h.on_open = [&](const Server::ClientPtr &c) {
    seen_client = true;
    std::weak_ptr<WsClient> w = c;
    srv->send_text(w, json{{"type", "hello"}, {"version", 1}, {"app", "wsdr-studio"}}.dump());
    srv->send_text(w, Engine::devices_json(scan_devices()).dump());
    srv->send_text(w, eng->caps().dump());
    srv->send_text(w, eng->settings().dump());
    srv->send_text(w, eng->status().dump());
  };
  h.on_text = [&](const Server::ClientPtr &c, const std::string &t) {
    std::weak_ptr<WsClient> w = c;
    json cmd = json::parse(t, nullptr, false);
    if (cmd.is_discarded() || !cmd.is_object()) {
      srv->send_text(w, json{{"type", "error"}, {"kind", "bad_request"}, {"msg", "not a JSON object"}}.dump());
      return;
    }
    eng->submit(std::move(cmd), [&srv, w](const json &r) { srv->send_text(w, r.dump()); });
  };
  std::string err;
  bool ok = false;
  for (int k = 0; k < 10 && !ok; k++) {
    so.port = static_cast<uint16_t>(a.port + k);
    srv = std::make_unique<Server>(io, so, h);
    ok = srv->listen(err);
  }
  if (!ok) {
    std::fprintf(stderr, "wsdr-studiod: cannot listen on 127.0.0.1:%u..%u: %s\n", a.port, a.port + 9, err.c_str());
    return 1;
  }
  eng = std::make_unique<Engine>(
      Engine::Callbacks{[&](std::vector<uint8_t> &&f) { srv->broadcast_binary(std::move(f)); },
                        [&](const json &e) { srv->broadcast_text(e.dump()); }},
      a.record_dir.empty() ? data_dir() + "/recordings" : a.record_dir);

  const std::string url = "http://127.0.0.1:" + std::to_string(srv->port()) + "/?t=" + so.token;
  {
    const std::string f = instance_file();
    std::ofstream o(f, std::ios::trunc);
    fs::permissions(f, fs::perms::owner_read | fs::perms::owner_write, fs::perm_options::replace);
    o << getpid() << " " << url << "\n";
  }
  std::fprintf(stderr, "wsdr-studiod: serving %s from %s\n", url.c_str(), so.webroot.c_str());
  if (a.pid)
    eng->submit(open_cmd(a), nullptr);
  if (a.browser)
    open_browser(url);

  net::signal_set sig(io, SIGINT, SIGTERM);
  sig.async_wait([&](const boost::system::error_code &, int) { io.stop(); });

  // 2 Hz status to all clients; exit after 30 s without clients once a browser has connected.
  net::steady_timer tick(io);
  auto idle_since = std::chrono::steady_clock::now();
  std::function<void()> on_tick = [&] {
    tick.expires_after(std::chrono::milliseconds(500));
    tick.async_wait([&](const boost::system::error_code &ec) {
      if (ec)
        return;
      if (srv->clients()) {
        idle_since = std::chrono::steady_clock::now();
        srv->broadcast_text(eng->status().dump());
      } else if (a.browser && seen_client &&
                 std::chrono::steady_clock::now() - idle_since > std::chrono::seconds(30)) {
        std::fprintf(stderr, "wsdr-studiod: no clients for 30 s, exiting\n");
        io.stop();
        return;
      }
      on_tick();
    });
  };
  on_tick();
  io.run();

  std::error_code ec;
  fs::remove(instance_file(), ec);
  eng.reset(); // closes the adapter before the server goes away
  srv.reset();
  return 0;
}
