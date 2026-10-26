// SPDX-License-Identifier: GPL-2.0-only
// The worker that runs wsdr-core (wasm/core.cpp: the engine in WebAssembly) for the web build. The page
// (transport.ts) first sends {t:'init', core: <url of wsdr-core.js>}, then the WorkerClient protocol
// (workerClient.ts). The worker's own thread must stay idle: it only relays messages; the engine's
// threads hand it their USB calls (libusb's WebUSB backend).
//
// Recordings: the engine writes into the page's storage (OPFS, mounted at /recordings); each finished
// one ("recorded") is moved into the folder the user picked ({t:'folder', handle}) before the event goes
// on, and paths in events name that folder instead of /recordings. Recordings already there when the
// worker starts (a tab closed while recording, a move that failed) go into the folder too, once there
// is one, with a notice.
/// <reference lib="webworker" />
import { leftoverRecordings, moveRecording } from './move';
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
let folder: FileSystemDirectoryHandle | null = null;
let leftovers: string[] = []; // listed before the engine could start a recording

async function moveLeftovers(to: FileSystemDirectoryHandle) {
  const bases = leftovers.splice(0);
  if (!bases.length) return;
  const root = await navigator.storage.getDirectory();
  const errors: string[] = [];
  for (const b of bases) {
    const r = await moveRecording(root, to, b);
    if (r.error) errors.push(r.error);
  }
  const text = `Moved ${bases.length === 1 ? 'a recording' : `${bases.length} recordings`} from an earlier session into ${to.name}: ${bases.join(', ')}` +
    (errors.length ? `. Some could not be moved (${errors.join('; ')}).` : '.');
  post({ t: 'text', text: JSON.stringify({ type: 'notice', text }) });
}
const DIR = '/recordings';

// "/recordings/x" in an event -> "<folder>/x" (JSON-escaped)
const named = (text: string) =>
  folder && text.includes(`"${DIR}/`) ? text.replaceAll(`"${DIR}/`, `"${JSON.stringify(folder.name).slice(1, -1)}/`) : text;

async function onCoreText(text: string) {
  if (!text.includes('"type":"recorded"')) return post({ t: 'text', text: named(text) });
  const e = JSON.parse(text);
  const base = String(e.file).replace(/^.*\//, '').replace(/\.sigmf-data$/, '');
  if (!folder) e.error = [e.error, 'no folder chosen: the file stays in the browser storage'].filter(Boolean).join('; ');
  else {
    const r = await moveRecording(await navigator.storage.getDirectory(), folder, base);
    if (r.error) e.error = [e.error, `could not move it into ${folder.name}: ${r.error}`].filter(Boolean).join('; ');
    else e.file = `${folder.name}/${base}.sigmf-data`;
  }
  post({ t: 'text', text: JSON.stringify(e) });
}

function handle(m: any) {
  if (m.t === 'folder') {
    folder = m.handle;
    return void moveLeftovers(m.handle).catch(() => {});
  }
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
      onCoreText: (text: string) => void onCoreText(text),
      onCoreBinary: (u8: Uint8Array) => post({ t: 'bin', buf: u8.buffer }, [u8.buffer]),
      print: (text: string) => post({ t: 'log', text }),
      printErr: (text: string) => post({ t: 'log', text }),
    });
    leftovers = await leftoverRecordings(await navigator.storage.getDirectory()).catch(() => []);
    const dir = m.stringToNewUTF8(DIR);
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
