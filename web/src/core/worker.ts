// SPDX-License-Identifier: GPL-2.0-only
// The worker that runs wsdr-core (wasm/core.cpp: the engine in WebAssembly) for the web build. The page
// (transport.ts) first sends {t:'init', core: <url of wsdr-core.js>}, then the WorkerClient protocol
// (workerClient.ts). The worker's own thread must stay idle: it only relays messages; the engine's
// threads hand it their USB calls (libusb's WebUSB backend).
/// <reference lib="webworker" />
type Core = {
  _core_start(dir: number): number;
  _core_client_open(): void;
  _core_text(json: number): void;
  _free(p: number): void;
  stringToNewUTF8(s: string): number;
};

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);
const queue: any[] = [];
let core: Core | null = null;

function handle(m: any) {
  if (!core) return void queue.push(m);
  if (m.t === 'open') core._core_client_open();
  else if (m.t === 'text') {
    const p = core.stringToNewUTF8(m.text);
    core._core_text(p);
    core._free(p);
  }
}

async function start(url: string) {
  try {
    const { default: createCore } = await import(/* @vite-ignore */ url);
    const m: Core = await createCore({
      onCoreText: (text: string) => post({ t: 'text', text }),
      onCoreBinary: (u8: Uint8Array) => post({ t: 'bin', buf: u8.buffer }, [u8.buffer]),
      print: (text: string) => post({ t: 'log', text }),
      printErr: (text: string) => post({ t: 'log', text }),
    });
    const dir = m.stringToNewUTF8('/recordings');
    const rc = m._core_start(dir);
    m._free(dir);
    if (rc) throw new Error('This browser did not give the page its storage (needed for recordings).');
    core = m;
    post({ t: 'ready' });
    for (const q of queue.splice(0)) handle(q);
  } catch (e) {
    post({ t: 'fatal', msg: `wsdr-studio could not start its engine: ${(e as Error)?.message ?? e}` });
  }
}

self.onmessage = ({ data }: MessageEvent) => (data.t === 'init' ? void start(data.core) : handle(data));
