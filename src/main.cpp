// SPDX-License-Identifier: GPL-2.0-only
// wsdr-studiod — the wsdr-studio backend: owns the adapter (via wifi-sdr/devourer), computes the
// spectrum and serves the web UI on http://127.0.0.1:PORT/, opened as a Chrome app window with a
// single-use launch key (see server.h for the security model).
//
//   wsdr-studiod [--port 8073] [--no-browser] [--web DIR] [--pid 0xb812] [--freq 5190e6] [--rate 40]
//                [--record-dir DIR] [--dev-origin http://localhost:5173]
//   wsdr-studiod --headless-seconds 20 --pid 0xb812 [--freq ..] [--rate ..] [--fft 8192]
//       engine + DSP only (no server, no browser); prints status JSON each second and a summary.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
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

// Private per-user file "pid port token" for the running instance (never in a shared /tmp).
std::string private_dir();
std::string instance_file() { return private_dir() + "/instance"; }

bool write_instance(const std::string &text) {
  const int fd = ::open(instance_file().c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0)
    return false;
  ::fchmod(fd, 0600);
  const bool ok = ::write(fd, text.data(), text.size()) == static_cast<ssize_t>(text.size());
  ::close(fd);
  return ok;
}

// Minimal blocking GET to 127.0.0.1:port (1 s timeout); returns the body of a 200 response.
std::string local_get(uint16_t port, const std::string &path) {
  const int fd = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0)
    return {};
  timeval tv{1, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  std::string resp;
  if (::connect(fd, reinterpret_cast<sockaddr *>(&a), sizeof a) == 0) {
    const std::string req = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + std::to_string(port) +
                            "\r\nConnection: close\r\n\r\n";
    if (::write(fd, req.data(), req.size()) == static_cast<ssize_t>(req.size())) {
      char buf[2048];
      ssize_t n;
      while ((n = ::read(fd, buf, sizeof buf)) > 0 && resp.size() < 16384)
        resp.append(buf, static_cast<size_t>(n));
    }
  }
  ::close(fd);
  if (resp.rfind("HTTP/1.1 200", 0) != 0)
    return {};
  const auto e = resp.find("\r\n\r\n");
  return e == std::string::npos ? std::string() : resp.substr(e + 4);
}

// A launch key from a running instance, or "" if none answers (stale file, crashed process).
std::string running_instance_url() {
  std::ifstream f(instance_file());
  long pid = 0;
  unsigned port = 0;
  std::string token;
  if (!(f >> pid >> port >> token) || port == 0 || port > 65535 || pid <= 0)
    return {};
  // Only talk to it if that pid is alive, ours, and wsdr-studiod: a crashed instance's port may now
  // belong to someone else's process, which must not be handed the token.
  struct stat ps {};
  const std::string proc = "/proc/" + std::to_string(pid);
  std::ifstream comm(proc + "/comm");
  std::string name;
  if (::stat(proc.c_str(), &ps) != 0 || ps.st_uid != getuid() || !std::getline(comm, name) || name != "wsdr-studiod")
    return {};
  const json j = json::parse(local_get(static_cast<uint16_t>(port), "/api/launch-key?t=" + token), nullptr, false);
  if (!j.is_object() || !j.contains("key") || !j["key"].is_string())
    return {};
  const std::string key = j["key"].get<std::string>();
  // whatever answers on that port is not trusted further than this: exactly 32 hex digits
  if (key.size() != 32 || key.find_first_not_of("0123456789abcdef") != std::string::npos)
    return {};
  return "http://127.0.0.1:" + std::to_string(port) + "/#k=" + key;
}

// Remove the instance file only if it still describes us (another instance may have replaced it).
void remove_instance_if_ours(const std::string &token) {
  std::ifstream f(instance_file());
  long pid = 0;
  unsigned port = 0;
  std::string t;
  if (f >> pid >> port >> t && t == token) {
    std::error_code ec;
    fs::remove(instance_file(), ec);
  }
}

// Private per-user directory for the instance file and launch pages (0700).
std::string private_dir() {
  const char *r = std::getenv("XDG_RUNTIME_DIR");
  const char *h = std::getenv("HOME");
  const std::string dir = r && *r ? std::string(r) + "/wsdr-studio" : std::string(h ? h : ".") + "/.cache/wsdr-studio";
  std::error_code ec;
  fs::create_directories(dir, ec);
  ::chmod(dir.c_str(), 0700);
  return dir;
}

// The launch URL carries a single-use key. Command lines are readable by every local user
// (/proc/PID/cmdline), so the browser is not given the URL itself but a private 0600 page that
// redirects to it; the page is deleted after 30 s. Returns "" if the page cannot be written.
std::string launch_page(const std::string &url) {
  std::random_device rd;
  char name[48];
  std::snprintf(name, sizeof name, "launch-%08x%08x.html", rd(), rd());
  const std::string path = private_dir() + "/" + name;
  const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0)
    return {};
  const std::string html = "<!doctype html><meta charset=\"utf-8\"><title>wsdr-studio</title>"
                           "<script>location.replace(\"" + url + "\")</script>\n";
  const bool ok = ::write(fd, html.data(), html.size()) == static_cast<ssize_t>(html.size());
  ::close(fd);
  if (!ok) {
    ::unlink(path.c_str());
    return {};
  }
  std::thread([path] {
    std::this_thread::sleep_for(std::chrono::seconds(30));
    ::unlink(path.c_str());
  }).detach();
  return "file://" + path;
}

// Launch pages are deleted after 30 s, but a short-lived second launch exits before that.
void remove_old_launch_pages() {
  std::error_code ec;
  const auto now = fs::file_time_type::clock::now();
  for (const auto &e : fs::directory_iterator(private_dir(), ec))
    if (e.path().filename().string().rfind("launch-", 0) == 0 && now - e.last_write_time(ec) > std::chrono::seconds(30))
      fs::remove(e.path(), ec);
}

// Where `name` is found on PATH ("" if not found), as listed (symlinks not followed).
std::string which(const std::string &name) {
  const char *p = std::getenv("PATH");
  std::string path = p ? p : "/usr/bin:/bin";
  for (size_t i = 0; i <= path.size();) {
    size_t e = path.find(':', i);
    if (e == std::string::npos)
      e = path.size();
    const fs::path f = fs::path(path.substr(i, e - i)) / name;
    std::error_code ec;
    if (access(f.c_str(), X_OK) == 0)
      return f.string();
    i = e + 1;
  }
  return {};
}

// A Snap browser: listed under /snap/, a link to /usr/bin/snap, or a wrapper script that runs a snap
// (Ubuntu's /usr/bin/chromium-browser).
bool is_snap(const std::string &exe) {
  std::error_code ec;
  if (exe.rfind("/snap/", 0) == 0 || fs::canonical(exe, ec).string() == "/usr/bin/snap")
    return true;
  std::ifstream f(exe, std::ios::binary);
  char head[4] = {};
  f.read(head, 4);
  if (f.gcount() == 4 && std::memcmp(head, "\x7f" "ELF", 4) == 0)
    return false;
  std::string text((std::istreambuf_iterator<char>(f)), {});
  return text.size() < 65536 && text.find("snap") != std::string::npos && exe.find("chromium") != std::string::npos;
}

// Open the UI: Chrome/Chromium as an app window, else the default browser. The child gets a clean
// environment for libraries (an AppImage's LD_LIBRARY_PATH must not leak into the browser).
// Normally the browser gets the private launch page (no key on its command line). Sandboxed
// browsers (Snap) cannot read that page, and xdg-open may hand off to one, so those get
// the single-use URL itself (valid 30 s).
void open_browser(const std::string &secret_url) {
  const std::string page = launch_page(secret_url);
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
  const std::string app = "--app=" + page, size = "--window-size=1440,900";
  const std::vector<std::vector<std::string>> cmds = {
      {"google-chrome", app, size}, {"google-chrome-stable", app, size}, {"chromium", app, size},
      {"chromium-browser", app, size},
      {"xdg-open", page}};
  for (auto c : cmds) {
    const std::string exe = which(c[0]);
    if (exe.empty())
      continue;
    const bool sandboxed = c[0] == "xdg-open" || is_snap(exe);
    std::string &target = c[1]; // the URL argument: "--app=URL" (Chrome/Chromium) or URL (xdg-open)
    if (sandboxed || page.empty())
      target = c[0] == "xdg-open" ? secret_url : "--app=" + secret_url;
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
      std::fprintf(stderr, "wsdr-studiod: opened the UI with %s (if no window appears, run wsdr-studiod again)\n",
                   argv[0]);
      return;
    }
  }
  std::fprintf(stderr, "wsdr-studiod: no browser found; open %s (single use, 30 s)\n", secret_url.c_str());
}

bool parse(int argc, char **argv, Args &a) try {
  for (int i = 1; i < argc; i++) {
    const std::string k = argv[i];
    auto v = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (k == "--port") {
      const int p = std::stoi(v());
      if (p < 1 || p > 65535 - 9)
        throw std::invalid_argument("port");
      a.port = static_cast<uint16_t>(p);
    }
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
} catch (const std::exception &) {
  std::fprintf(stderr, "bad option value\n");
  return false;
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
    eng.poll();
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
  // A lost or failed adapter is closed by the engine, which leaves its reason in "error".
  const bool failed = s["state"] != "open" || !s.value("error", std::string()).empty();
  return failed ? 1 : 0;
}

} // namespace

int main(int argc, char **argv) {
  Args a;
  if (!parse(argc, argv, a)) {
    std::fprintf(stderr, "usage: wsdr-studiod [--port N] [--no-browser] [--web DIR] [--pid 0xb812|0xc812] [--freq HZ] "
                         "[--rate MSPS] [--record-dir DIR] | --headless-seconds N --pid ...\n");
    return 2;
  }
  if (!a.record_dir.empty()) {
    std::error_code ec;
    a.record_dir = fs::absolute(a.record_dir, ec).string();
  }
  if (a.headless > 0)
    return run_headless(a);
  remove_old_launch_pages();

  // Single instance: if one is already serving, open a new window on it.
  if (const std::string url = running_instance_url(); !url.empty()) {
    std::fprintf(stderr, "wsdr-studiod: already running\n");
    if (a.browser)
      open_browser(url);
    else
      std::fprintf(stderr, "wsdr-studiod: open %s (single use, 30 s)\n", url.c_str());
    return 0;
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
    const char *home = std::getenv("HOME");
    srv->send_text(w, json{{"type", "hello"}, {"version", 1}, {"app", "wsdr-studio"}, {"home", home ? home : ""}}.dump());
    eng->submit({{"cmd", "scan"}}, nullptr); // broadcasts "devices"; USB enumeration stays off the I/O thread
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
    if (cmd.contains("cmd") && cmd["cmd"].is_string() && cmd["cmd"].get<std::string>().rfind('_', 0) == 0) {
      json e = {{"type", "error"}, {"kind", "bad_request"}, {"msg", "unknown command"}};
      if (cmd.contains("id"))
        e["id"] = cmd["id"];
      srv->send_text(w, e.dump());
      return; // internal commands (_lost, _rec_stop) are the engine's own
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

  if (!write_instance(std::to_string(getpid()) + " " + std::to_string(srv->port()) + " " + so.token + "\n"))
    std::fprintf(stderr, "wsdr-studiod: cannot write %s (a second launch will not find this one)\n",
                 instance_file().c_str());
  std::fprintf(stderr, "wsdr-studiod: serving http://127.0.0.1:%u/ from %s\n", srv->port(), so.webroot.c_str());
  if (a.pid)
    eng->submit(open_cmd(a), nullptr);
  if (a.browser)
    open_browser("http://127.0.0.1:" + std::to_string(srv->port()) + "/#k=" + srv->new_launch_key());
  else
    std::fprintf(stderr, "wsdr-studiod: open http://127.0.0.1:%u/#k=%s (single use, 30 s)\n", srv->port(),
                 srv->new_launch_key().c_str());

  net::signal_set sig(io, SIGINT, SIGTERM, SIGHUP); // SIGHUP: the terminal closed; finalise cleanly
  sig.async_wait([&](const boost::system::error_code &, int) { io.stop(); });

  // 2 Hz status to all clients; exit after 30 s without clients once a browser has connected.
  net::steady_timer tick(io);
  auto idle_since = std::chrono::steady_clock::now();
  const auto launched = idle_since;
  std::function<void()> on_tick = [&] {
    tick.expires_after(std::chrono::milliseconds(500));
    tick.async_wait([&](const boost::system::error_code &ec) {
      if (ec)
        return;
      eng->poll(); // notices an unplugged adapter
      if (srv->clients()) {
        idle_since = std::chrono::steady_clock::now();
        json st = eng->status();
        st["client_drops"] = srv->frames_dropped();
        srv->broadcast_text(st.dump());
      } else if (a.browser && seen_client && !eng->status()["record"]["active"].get<bool>() &&
                 std::chrono::steady_clock::now() - idle_since > std::chrono::seconds(30)) {
        std::fprintf(stderr, "wsdr-studiod: no clients for 30 s, exiting\n");
        io.stop();
        return;
      } else if (a.browser && !seen_client && std::chrono::steady_clock::now() - launched > std::chrono::minutes(2)) {
        std::fprintf(stderr, "wsdr-studiod: no browser connected within 2 minutes (did the window open?), exiting\n");
        io.stop();
        return;
      }
      on_tick();
    });
  };
  on_tick();
  io.run();

  remove_instance_if_ours(so.token);
  eng.reset(); // closes the adapter before the server goes away
  srv.reset();
  return 0;
}
