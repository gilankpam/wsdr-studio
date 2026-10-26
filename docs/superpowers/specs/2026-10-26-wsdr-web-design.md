# wsdr-studio in the browser: design

_2026-10-26 · status: agreed; feasibility in `wasm/README.md`_

## Goal
wsdr-studio runs as a web page in Chrome: the user opens a URL, pairs the dongle, presses Start. No
install. The Electron app stays, built from the same C++ engine and React UI.

## Decisions
- **Alongside, shared code.** One engine (`src/engine.*`, `dsp.*`, `wifi.*`, `recorder.*`), one UI
  (`web/`). Native: `wsdr-studiod` + WebSocket server + Electron, unchanged for the user. Web: the
  engine compiled to WASM, in a dedicated worker, talking to the UI by `postMessage` with the same
  protocol v1 (JSON events and commands, binary rows). The UI picks its transport at startup: the
  Electron bridge (`window.wsdr`) means WebSocket; otherwise WebUSB in a cross-origin-isolated page
  means the worker; otherwise it says which browser is needed.
- **Threads as they are.** The engine keeps its threads (command, DSP, Wi-Fi, disk, the Receiver's
  stream thread, the recorder's writer) as pthreads. libusb forwards their USB calls to the module's
  main thread, which therefore never blocks: commands are queued, the 2 Hz status tick is a pthread.
- **Build:** Emscripten 4.0.12, `-pthread`, JSPI, fixed heap, libusb 1.0.29's WebUSB backend (built
  from source by `wasm/libusb`). FFT: pocketfft in the WASM build (FFTW stays native).
- **Hosting: GitHub Pages** (`gilankpam/wsdr-studio`), built by a GitHub Actions workflow. Pages
  cannot send COOP/COEP, so the web build ships `coi-serviceworker` (the first visit reloads once).
- **Browser:** Chrome / Chromium desktop, 137 or newer (JSPI on by default). Others get a message.

## v1 features (web)
- Single view: spectrum + waterfall, tuning, span, gain/AGC, band ruler.
- Wi-Fi frame marks and network names.
- Recording (SigMF) into a folder the user picks (File System Access API). The recorder writes into
  the origin-private file system (WASMFS OPFS backend, `/recordings`); each finished file is moved into
  the picked folder.
- Two dongles: Panorama, Compare, Map (Map needs one).
- Pairing: a "Pair adapter…" button (WebUSB chooser); paired adapters come back on reload.

## Platform differences the UI shows (web)
- Linux: Chrome cannot take the dongle from rtw88; a claim failure says to unload or blacklist it.
  The udev rule is still needed.
- No free-space figure (no API for a picked folder): the recording line leaves it out.
- 8812BU at 20/40 MS/s: offered, unverified (projected CPU-bound, `wasm/README.md`).

## Not in v1
Remote access, other browsers, Android/macOS/Windows testing, a JS bulk-IN fast path.
