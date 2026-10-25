// SPDX-License-Identifier: GPL-2.0-only
// Client side of protocol v1 (src/protocol.h): JSON commands with ids, JSON events, binary rows.

export type Device = {
  pid: number; model: string; chip: string; bus: number; port: string; speed_mbps: number;
  controller: string; driver: string; can_open: boolean; max_msps: number;
};
export type Caps = {
  open: boolean; adapter?: string; pid?: number; chip?: string; superspeed?: boolean; paths?: number;
  rates?: { rate_sel: number; fs: number }[]; gain_max?: number; gain_step?: number; wide_capable?: boolean;
};
export type RxSettings = { freq: number; rate_sel: number; wide: boolean; agc: boolean; gain_db: number };
export type DspSettings = { fft: number; rows_per_s: number; paths: 'a' | 'b' | 'ab'; dc_remove: boolean };
export type Status = {
  state: string; adapter: string; error: string; t: number; rows: number; ring_dropped: number; dsp_load: number;
  rx?: { state: string; banks: number; restarts: number; channel: number; width: number; centre: number; fs: number; error: string };
  record: { active: boolean; file: string; samples: number; seconds: number; bytes: number; error: string };
  client_drops?: number;
  disk_free?: number; // bytes free where recordings go
};
export type Row = {
  path: number; gen: number; seq: number; bins: number; t: number; f0: number; df: number;
  avg: Float32Array; max: Float32Array;
};

const MAGIC = 0x57525357;
const HEADER = 48;

export function decodeRow(buf: ArrayBuffer): Row | null {
  if (buf.byteLength < HEADER) return null;
  const v = new DataView(buf);
  if (v.getUint32(0, true) !== MAGIC || v.getUint16(4, true) !== 1) return null;
  const bins = v.getUint32(12, true);
  if (buf.byteLength !== HEADER + 2 * bins) return null;
  const dbMin = v.getFloat32(40, true), dbStep = v.getFloat32(44, true);
  const u = new Uint8Array(buf, HEADER);
  const avg = new Float32Array(bins), max = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    avg[i] = dbMin + dbStep * u[i];
    max[i] = dbMin + dbStep * u[bins + i];
  }
  return {
    path: v.getUint8(6), gen: v.getUint8(7), seq: v.getUint32(8, true), bins, t: v.getFloat64(16, true),
    f0: v.getFloat64(24, true), df: v.getFloat64(32, true), avg, max,
  };
}

const TOKEN_KEY = 'wsdr-studio.token';
let sessionPromise: Promise<string> | null = null;

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };

export class Client {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  onEvent: (e: any) => void = () => {};
  onRow: (r: Row) => void = () => {};
  onConnection: (up: boolean) => void = () => {};
  onGiveUp: (why: string) => void = () => {};
  private failures = 0; // connection attempts that never opened, in a row

  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  // The session token: the launch link carries a single-use key in the URL fragment (#k=, never sent to
  // the server by the browser); it is exchanged once for the token, which this tab keeps in
  // sessionStorage (per origin, so per port, and per tab: reloads keep working). ?t= also works.
  static fromLocation(): Promise<Client> {
    sessionPromise ??= Client.exchange();
    return sessionPromise.then((url) => new Client(url));
  }

  private static async exchange(): Promise<string> {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = (t: string) => `${proto}//${location.host}/ws?t=${encodeURIComponent(t)}`;
    const key = new URLSearchParams(location.hash.slice(1)).get('k');
    if (key) {
      history.replaceState(null, '', location.pathname); // the key is spent either way
      const r = await fetch(`/api/session?k=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (r.ok) {
        const { token } = await r.json();
        try {
          sessionStorage.setItem(TOKEN_KEY, token);
        } catch {
          /* storage blocked: this page still works until reload */
        }
        return url(token);
      }
    }
    let t = new URLSearchParams(location.search).get('t');
    try {
      t = t ?? sessionStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage blocked */
    }
    if (!t) throw new Error('This window has no session. Start wsdr-studio again to open a new one.');
    return url(t);
  }

  connect() {
    this.closed = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.failures = 0;
      this.onConnection(true);
    };
    ws.onclose = () => {
      this.onConnection(false);
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      if (this.closed) return;
      if (!opened && ++this.failures >= 3) {
        // refused (stale session after a restart) or nobody listening (the app has exited)
        this.onGiveUp('Lost the connection to wsdr-studio (it was closed or restarted). Start wsdr-studio again.');
        return;
      }
      setTimeout(() => this.connect(), 1000);
    };
    ws.onmessage = (m) => {
      if (m.data instanceof ArrayBuffer) {
        const r = decodeRow(m.data);
        if (r) this.onRow(r);
        return;
      }
      const e = JSON.parse(m.data as string);
      if ((e.type === 'ack' || e.type === 'error') && typeof e.id === 'number' && this.pending.has(e.id)) {
        const p = this.pending.get(e.id)!;
        this.pending.delete(e.id);
        if (e.type === 'ack') p.resolve(e);
        else p.reject(Object.assign(new Error(e.msg ?? 'error'), { kind: e.kind as string | undefined }));
        return;
      }
      this.onEvent(e);
    };
    this.ws = ws;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  request(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ cmd, id, ...args }));
    });
  }
}
