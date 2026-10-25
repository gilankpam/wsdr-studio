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
  record: { active: boolean; file: string; samples: number; dropped: number; seconds: number; bytes: number; error: string };
  client_drops?: number;
};
export type Row = {
  path: number; seq: number; bins: number; t: number; f0: number; df: number;
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
    path: v.getUint8(6), seq: v.getUint32(8, true), bins, t: v.getFloat64(16, true),
    f0: v.getFloat64(24, true), df: v.getFloat64(32, true), avg, max,
  };
}

type Pending = { resolve: (r: any) => void; reject: (e: Error) => void };

export class Client {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  onEvent: (e: any) => void = () => {};
  onRow: (r: Row) => void = () => {};
  onConnection: (up: boolean) => void = () => {};

  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  // The session cookie (set when the launch link was opened) authenticates the socket; ?t= in the
  // page URL is accepted too (scripts, development).
  static fromLocation(): Client {
    const t = new URLSearchParams(location.search).get('t');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Client(`${proto}//${location.host}/ws${t ? `?t=${encodeURIComponent(t)}` : ''}`);
  }

  connect() {
    this.closed = false;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this.onConnection(true);
    ws.onclose = () => {
      this.onConnection(false);
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      if (!this.closed) setTimeout(() => this.connect(), 1000);
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
        else p.reject(new Error(e.msg ?? 'error'));
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
