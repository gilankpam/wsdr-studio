// SPDX-License-Identifier: GPL-2.0-only
// The web build's transport: protocol v1 with wsdr-core (the engine in WebAssembly) in a worker
// (core/worker.ts). Page -> worker: {t:'open'} once it is ready, {t:'text', text} per command.
// Worker -> page: {t:'ready'}, {t:'fatal', msg}, {t:'text', text}, {t:'bin', buf}, {t:'log', text}.
import { decodeRow, onText, type Pending, type Row } from './protocol';

export type WorkerLike = {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: any }) => void) | null;
  terminate(): void;
};

export class WorkerClient {
  readonly kind = 'web' as const;
  onEvent: (e: any) => void = () => {};
  onRow: (r: Row) => void = () => {};
  onConnection: (up: boolean) => void = () => {};
  onGiveUp: (why: string) => void = () => {};
  private makeWorker: () => WorkerLike;
  private w: WorkerLike | null = null;
  private ready = false;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(makeWorker: () => WorkerLike) {
    this.makeWorker = makeWorker;
  }

  // The engine lives as long as its worker: connect once; a later connect (after close) starts afresh.
  connect() {
    if (this.w) return;
    const w = (this.w = this.makeWorker());
    w.onmessage = ({ data: m }) => {
      if (m.t === 'text') onText(m.text, this.pending, this.onEvent);
      else if (m.t === 'bin') {
        const r = decodeRow(m.buf);
        if (r) this.onRow(r);
      } else if (m.t === 'ready') {
        this.ready = true;
        w.postMessage({ t: 'open' });
        this.onConnection(true);
      } else if (m.t === 'fatal') this.onGiveUp(String(m.msg));
      else if (m.t === 'log') console.debug('[wsdr-core]', m.text);
    };
  }

  close() {
    this.w?.terminate(); // the browser releases the adapters with the worker
    this.w = null;
    if (this.ready) this.onConnection(false);
    this.ready = false;
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
  }

  request(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!this.w || !this.ready) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.w!.postMessage({ t: 'text', text: JSON.stringify({ cmd, id, ...args }) });
    });
  }
}
