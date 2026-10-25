# wsdr-studio

A desktop app that turns a Realtek RTL8812BU (or RTL8812CU) USB Wi-Fi dongle into a live spectrum
receiver: plug it in, press Start, pick a Wi-Fi channel, watch the spectrum and waterfall.

- **How it works:** it uses the receive path from [wifi-sdr](https://github.com/snokvist/wifi-sdr),
  which streams the chip's baseband sample ring (LA mode) over USB with custom on-chip code, brought
  up by [devourer](https://github.com/OpenIPC/devourer). A C++ backend owns the dongle and computes
  the spectrum; the UI (React) runs in a bundled Electron window. No browser needs to be installed.
- **What you get:**
  - 8812BU on USB 3: spans of 2.5–40 MHz, and the full 40 MHz band at 40 MS/s.
  - 8812BU on USB 2, or the 8812CU: 2.5 and 5 MHz.
  - 8812CU: two coherent antennas (A, B, or both overlaid).
  - Fixed gain or the chip's AGC, and raw IQ recording (SigMF).
- **Receive only.** The app never transmits.
- **Platform:** Linux, x86-64, glibc ≥ 2.34 (Ubuntu 22.04 or newer and similar).

## Run it

```sh
./wsdr-studio-x86_64.AppImage
```

The app window opens and starts the backend. Closing the window ends the app (it asks first while a
recording is running; the file is always saved). Starting it again while it runs brings the window
to the front. Options for the backend can be given on the command line, e.g.
`./wsdr-studio-x86_64.AppImage --pid 0xb812 --freq 5190e6 --rate 40` starts streaming right away.

**Sandbox:** Electron's Chromium sandbox needs unprivileged user namespaces, and an AppImage cannot
ship the setuid helper that replaces them. Where they are blocked (Ubuntu 24.04+ by default) the app
runs without that sandbox. The window only ever loads the app's own page from 127.0.0.1 (navigation,
new windows and permissions are locked down), so no outside web content is ever shown in it.

**One-time setup** (needs root):
- **USB access:** install the udev rule from wifi-sdr, then replug the dongle:
  ```sh
  sudo cp tools/99-wsdr.rules /etc/udev/rules.d/ && sudo udevadm control --reload
  ```
  Without it the app shows a "No permission" strip with this command.
- **Kernel drivers:** the in-kernel drivers (rtw88_8822bu/cu) claim the dongle on plug-in; Start
  takes it over. wifi-sdr's `tools/rtw88_guard.sh on` keeps them away for good.
- **USB 3 on the 8812BU:** this dongle enumerates at USB 2 after a plain replug. Its USB 3 mode is
  entered when a driver switches it (rtw88 does this on probe). The app shows the link speed next to
  the adapter name, and spans above 5 MHz need USB 3.

Recordings go to `~/.local/share/wsdr-studio/recordings/` as `.sigmf-data` (int16 I/Q,
12-bit samples << 4, at the hardware centre frequency) plus `.sigmf-meta`. A retune, a span change or
a stream restart ends the current file, so each file has one centre and one rate and no gaps.

## Build

```sh
git clone --recursive https://github.com/snokvist/wsdr-studio   # or: git submodule update --init external/wifi-sdr
git -C external/wifi-sdr submodule update --init external/devourer   # not --recursive (reference trees)
# deps (Ubuntu): cmake g++ pkg-config libusb-1.0-0-dev libfftw3-dev libboost-dev nlohmann-json3-dev
#                binutils-mipsel-linux-gnu xxd nodejs npm
cmake -S . -B build && cmake --build build -j
(cd web && npm ci && npm run build)
(cd desktop && npm ci && npm start)  # the app window (Electron) on build/wsdr-studiod
build/test_core                        # unit tests (no hardware); build/test_core --bench: DSP at 40 MS/s
```

**Desktop shell (dev):** `cd desktop && npm ci && npm start` runs Electron on `build/wsdr-studiod`
and `web/dist` (if Electron's binary is missing, run `node node_modules/electron/install.js`).
`WSDR_DEV_URL=http://localhost:5173 npm start` with `npm run dev` in `web/` uses the Vite dev server.

**AppImage:** `scripts/build-appimage.sh` builds the web UI on the host and the backend inside an
Ubuntu 22.04 container (Docker), then packages it with pinned, checksummed linuxdeploy, appimagetool,
AppImage runtime and Electron (about 115 MB). Output: `build-appimage/wsdr-studio-x86_64.AppImage`.

**Headless check:** `build/wsdr-studiod --headless-seconds 20 --pid 0xb812 --freq 5190e6 --rate 40`
runs the engine and DSP without a UI and prints status JSON. `build/wsdr-studiod --pid 0xb812` alone
runs the server without a window (for scripts). `node tests/e2e.mjs [--record]` checks a running
instance: security gates, protocol, a retune, and a recording.

## Security model

The backend listens on 127.0.0.1 only and checks every request's `Host` header against DNS rebinding.
- **The WebSocket** needs the per-launch session token (`?t=`), and a browser's `Origin` must be the
  app's own.
- **The token is never in a URL or on a command line.** The backend prints it once on a private pipe to
  the Electron shell, which hands it to its own page over IPC (the page cannot get it any other way;
  no HTTP endpoint returns it, no cookies). Scripts read it from a private per-user file
  (`$XDG_RUNTIME_DIR/wsdr-studio/instance`, mode 0600).
- **The window is locked to the app:** context isolation, sandboxed renderer, no Node in the page,
  navigation only within the app's origin, no new windows, no permissions except writing the
  clipboard.
- **No remote access.**

## Layout

| Path | What |
|---|---|
| `src/` | backend: `engine` (adapter, DSP thread, recorder), `dsp` (FFT), `server` (HTTP/WebSocket), `protocol`, `recorder` (SigMF), `device_scan` |
| `web/` | React + TypeScript UI (Vite): `App.tsx` controls, `display.ts` spectrum + waterfall |
| `desktop/` | Electron shell: `main.js` (starts the backend, window, lock-down), `preload.js` (token bridge) |
| `external/wifi-sdr` | the receive core (submodule; brings devourer) |
| `docs/` | design and build plan |
| `tests/` | unit tests (C++) and the end-to-end check (Node) |

License: GPL-2.0-only (it links wifi-sdr and devourer, both GPL-2.0).
