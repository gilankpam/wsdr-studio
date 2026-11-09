# WebUSB spike: wsdr-studio in Chrome, no native backend

**Question:** can the backend (wifi-sdr + devourer) run inside Chrome as WebAssembly and drive the
dongle over WebUSB, fast enough for the app's spans?

## Layout
| Path | What |
|---|---|
| `build.sh` | libusb (Emscripten/WebUSB backend, compiled from source, no configure) → wifi-sdr + devourer → `web/<mode>/wsdr-probe.{js,wasm}` |
| `libusb/` | the CMake build and hand-written `config.h` for libusb |
| `probe.cpp` | exports `probe_list`, `probe_stream`, `probe_usb3`: one pass of `Receiver::worker()` on one thread |
| `web/` | the probe page (`index.html`), the worker, the loader |
| `serve.mjs` | static server with COOP/COEP (the build uses shared memory) |

## Build and run
```sh
nix shell nixpkgs#emscripten nixpkgs#cmake nixpkgs#pkg-config nixpkgs#xxd nixpkgs#gnumake \
  nixpkgs#pkgsCross.mipsel-linux-gnu.buildPackages.binutils -c sh -c 'wasm/build.sh jspi && wasm/build.sh asyncify'
node wasm/serve.mjs          # http://localhost:8080/
```
In Chrome: **Pair a dongle…** → **Load** (build: jspi, run in: worker) → **List** → **Every rate**.
Before that: close wsdr-studio, keep rtw88 off the dongle (`sudo modprobe -r rtw88_8822bu rtw88_8822cu` or
the blacklist from the main README: Chrome cannot detach a kernel driver), udev rule in place.

## Findings so far (step 1, no hardware; Chrome 147, Emscripten 4.0.12, libusb 1.0.29)
- devourer (8822B/8822C paths) and the wifi-sdr core compile to WASM **without source changes**:
  2.0 MB (JSPI) / 3.0 MB (Asyncify).
- libusb's Emscripten event loop needs wasm atomics → `-pthread` → the page must be cross-origin
  isolated (COOP/COEP headers). No thread is started: WebUSB calls go to the module's own thread.
- The module loads and runs in a **dedicated worker**; WebUSB, cross-origin isolation and JSPI are all
  available there. libusb enumerates through `navigator.usb.getDevices()`.
- libusb infers SuperSpeed from `bMaxPacketSize0 = 9`, so the 504-byte EP0 cap on USB 3 still works.
- Not usable in the browser: devourer's thermal thread (`thermal_track` off, as `Receiver` already
  does), libusb port paths (WebUSB has none; the backend gives each device a session id).

## Step 2: on hardware (8812CU, USB 2, 2026-10-26)
Chrome 147 on Linux (NixOS), rtw88 not loaded, device paired once (it has a serial: the permission is
kept). Full devourer bring-up and streaming from the WASM worker, 15 s per run:

| fs | mode | got | USB | stale | faults | end max / period |
|---|---|---|---|---|---|---|
| 2.5 MS/s | continuous | 2.50 MS/s | 20 MB/s | 0 | 0 | 1509 / 3277 µs |
| 5 MS/s | continuous | **5.00 MS/s** | 40 MB/s | 0 | 0 | 1506 / 1638 µs |
| 10 MS/s | gapped | 35.3 % sampled | 28 MB/s | 0 | 0 | |
| 20 MS/s | gapped | 21.4 % sampled | 34 MB/s | 0 | 0 | |
| 40 MS/s | gapped | 12.0 % sampled | 38 MB/s | 0 | 0 | |

Gapped duty cycles match the native app (35 / 21 / 12 %).

- **Variants at 5 MS/s, all clean:** Asyncify in the worker; JSPI on the page; JSPI in the worker
  while the page is blocked 60 ms of every 100 ms (UI stalls do not reach the USB path).
  Depth 32 faults (deadline) after 1.4 s, as natively: the 8812CU wants ~100 ms queued (256).
- **Bring-up: 39.6 s, the same natively** (13,128 EP0 transfers). A vendor register read takes
  3.000 ms on this chip over USB 2 in raw WebUSB (page or worker, 1 or 8 in flight) and in native
  libusb alike: the time is the chip's, not the browser's.
- **CPU at 5 MS/s (40 MB/s, ~3,050 bulk transfers/s):** browser process 22 %, renderer (worker) 17 %
  of a core; native `wsdr_rxtest` 3 %. About 73 µs (browser) + 54 µs (renderer) per 16 KiB transfer.

- **The app's threads work as they are** (`probe_rx`): `wsdr::Receiver` with its own stream thread,
  opened from a command thread, streams 5.00 MS/s with 0 restarts. libusb forwards every USB call from
  those pthreads to the module's (idle) main thread. Cost: renderer 32 % of a core (17 % single-
  threaded), browser process unchanged (23 %). So `Engine` (command, DSP, Wi-Fi, disk threads) can be
  compiled as it is; only the server is replaced.

### What it says about the 8812BU (not measured: no dongle)
Its C2H packets are the same 16 KiB, so cost scales with the rate. Linear projection:
| fs | MB/s | transfers/s | browser proc | worker |
|---|---|---|---|---|
| 10 MS/s | 80 | 6.1k | ~45 % | ~33 % |
| 20 MS/s | 160 | 12.2k | ~90 % | ~66 % |
| 40 MS/s | 320 | 24.4k | ~180 % | ~130 % |

40 MS/s (the full 40 MHz band) is unlikely over WebUSB as transfers stand; 10 MS/s looks fine,
20 MS/s marginal. Levers: bigger C2H packets (fewer transfers; an on-chip program change), and a
JS bulk-IN reader instead of libusb for the stream (only the worker's share). Needs an 8812BU on USB 3.

## App on hardware (the web version, 2026-10-26)
The built app (`web/dist-web`) in Chrome 147 on the 8812CU, `tests/web-e2e.mjs` and `tests/web-core.mjs`:

| Check | Result |
|---|---|
| Bring-up from Start | 40 s (as natively) |
| Single view, 5 MS/s | 24.4 rows/s, 0 restarts, 0 banks dropped, dsp_load 0.07 |
| Rate change, retune, back (one session) | streaming throughout, 0 restarts |
| 2437 MHz, 20 MHz gapped | streams; Wi-Fi marks: not exercised (the finder needs continuous 20/40 MS/s) |
| Spectral Map pattern: 20 retunes, 300 ms apart | all acked, 0 restarts |
| Reload while open, second slot on the same adapter | released / refused, as natively |
| Slot B with one adapter | busy (A's) / not_found (no 8812BU); Panorama and Compare disabled ("Needs a second adapter") |
| A second tab while streaming | its Start fails with the Chrome hint (rtw88 / other program); the first tab streams on |
| 10 s recording, 5 MS/s | 200.1 MB + meta in the picked folder, nothing left in the page storage |
| Unplug while streaming, replug (by hand, `tests/web-unplug.mjs`) | "unplugged" shown; after replug (a new WebUSB device, same serial: still paired) it streams again by itself |
| CPU, 5 MS/s, UI drawing | renderer 36 %, browser process 24 %, GPU process 9 % of a core |

- **Stream restarts needed a fix.** libusb's WebUSB backend cannot cancel a transfer (its cancel is a
  no-op), so a stopped stream's queued reads stayed posted and swallowed the next run's first packets
  (framing faults on every retune). `usb_abort.cpp` (linked with `--wrap`) aborts them the WebUSB way:
  release and re-claim the interface (~1 ms, nothing sent to the chip).
- **libusb under WASMFS** needs `libusb/fcntl_shim.c` (WASMFS refuses O_NONBLOCK on libusb's pipe).
- **DSP and Wi-Fi decoder in WASM:** `tests/test_core.cpp` built as `wsdr-test-core` passes under Node
  (`build.sh` runs it), the synthetic Wi-Fi frames and SSIDs included.

## Not yet tested
- **Two dongles** (Panorama, Compare, two engines streaming at once): only one 8812CU was available.
- **The 8812BU:** the USB 3 switch (the dongle re-enumerates; Chrome must still see it as paired, which
  needs a serial number), 10–40 MS/s continuous (projected CPU-bound at 40 MS/s, above), and live Wi-Fi
  marks (they need continuous 20/40 MS/s).
- **Other platforms:** macOS (no driver to fight: should just work), Windows (the dongle needs the WinUSB
  driver, e.g. via Zadig), Android Chrome (OTG; USB 3 varies by phone).

