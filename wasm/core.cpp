// SPDX-License-Identifier: GPL-2.0-only
// wsdr-core: the engine (studio::Studio, two view slots) in WebAssembly, for the web version. It runs in
// a dedicated worker (web/src/core/worker.ts, or wasm/web/core/worker.js for the tests); protocol v1
// (src/protocol.h) goes through postMessage instead of a WebSocket.
//
// Threads: the engines' threads are pthreads. libusb's WebUSB backend forwards their USB calls to this
// module's main thread (the worker's own), so that thread must never block: the exports below only
// queue work, and the 2 Hz tick runs on a pthread of its own. Text and row frames produced on any
// thread are copied to the heap and delivered on the main thread (Module.onCoreText / onCoreBinary).
#include <emscripten.h>
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>

#include "studio.h"

namespace {

std::unique_ptr<studio::Studio> g_studio;

void to_page_text(std::string t) {
  char *p = strdup(t.c_str());
  MAIN_THREAD_ASYNC_EM_ASM({ Module.onCoreText(UTF8ToString($0)); _free($0); }, p);
}

void to_page_binary(std::vector<uint8_t> &&f) {
  auto *p = static_cast<uint8_t *>(std::malloc(f.size()));
  std::memcpy(p, f.data(), f.size());
  // slice(): a copy in a plain (transferable) ArrayBuffer, not the shared heap
  MAIN_THREAD_ASYNC_EM_ASM({ Module.onCoreBinary(HEAPU8.slice($0, $0 + $1)); _free($0); }, p, f.size());
}

} // namespace

extern "C" {

// Recordings go to record_dir, the origin-private file system (OPFS) mounted there. 0 = started.
EMSCRIPTEN_KEEPALIVE int core_start(const char *record_dir) {
  if (g_studio)
    return 0;
  if (wasmfs_create_directory(record_dir, 0777, wasmfs_create_opfs_backend()) != 0)
    return 1;
  g_studio = std::make_unique<studio::Studio>(studio::Studio::Out{to_page_text, to_page_binary}, record_dir, true, "");
  std::thread([] {
    for (;;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
      g_studio->tick(true, 0);
    }
  }).detach();
  return 0;
}

// The page connected (hello, then each slot's state).
EMSCRIPTEN_KEEPALIVE void core_client_open() { g_studio->client_open(to_page_text); }

// One command from the page (protocol v1 JSON); the reply arrives through onCoreText.
EMSCRIPTEN_KEEPALIVE void core_text(const char *json) { g_studio->client_text(json, to_page_text); }

} // extern "C"
