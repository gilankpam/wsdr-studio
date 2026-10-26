// SPDX-License-Identifier: GPL-2.0-only
// Which backend this page talks to: the desktop app's (Electron's bridge -> its WebSocket) or its own
// (the web build: the engine in a worker, the adapters over WebUSB). Both speak protocol v1.
import { Client, type Bridge, type Row } from './protocol';
import { WorkerClient, type WorkerLike } from './workerClient';

export interface Transport {
  readonly kind: 'desktop' | 'web';
  onEvent: (e: any) => void;
  onRow: (r: Row) => void;
  onConnection: (up: boolean) => void;
  onGiveUp: (why: string) => void;
  connect(): void;
  close(): void;
  request(cmd: string, args?: Record<string, unknown>): Promise<any>;
  setFolder?(handle: FileSystemDirectoryHandle): void; // web: where recordings end up
}

export type TransportEnv = {
  bridge?: Bridge;                              // window.wsdr (the desktop shell's preload)
  location?: { protocol: string; host: string };
  usb?: unknown;                                // navigator.usb
  isolated?: boolean;                           // crossOriginIsolated (shared memory)
  jspi?: boolean;                               // WebAssembly.Suspending (Chrome 137+)
  makeWorker?: () => WorkerLike;
};

export const NEEDS_CHROME = 'wsdr-studio needs Chrome or Chromium (version 137 or newer) on a desktop computer.';
// The browser can, but the page is not cross-origin isolated yet: on hosts without COOP/COEP (GitHub
// Pages) coi-serviceworker reloads the page once to add them; this shows only if that did not happen.
export const NEEDS_ISOLATION =
  'The page is reloading once to finish setting up. If this stays, reload it; if it still stays, this browser blocks the service worker the page needs (private windows can).';

let desktop: Promise<Client> | null = null; // one session per page (the shell hands out one token)

export function openTransport(env: TransportEnv = browserEnv()): Promise<Transport> {
  if (env.bridge && env.location) return (desktop ??= Client.fromBridge(env.bridge, env.location));
  if (env.usb && env.jspi && env.makeWorker) {
    if (!env.isolated) return Promise.reject(new Error(NEEDS_ISOLATION));
    return Promise.resolve(new WorkerClient(env.makeWorker));
  }
  return Promise.reject(new Error(NEEDS_CHROME));
}

function browserEnv(): TransportEnv {
  return {
    bridge: (window as { wsdr?: Bridge }).wsdr,
    location,
    usb: (navigator as { usb?: unknown }).usb,
    isolated: self.crossOriginIsolated === true,
    jspi: typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function',
    makeWorker: () => {
      const w = new Worker(new URL('./core/worker.ts', import.meta.url), { type: 'module', name: 'wsdr-core' });
      w.postMessage({ t: 'init', core: new URL('core/wsdr-core.js', document.baseURI).href });
      return w as unknown as WorkerLike;
    },
  };
}
