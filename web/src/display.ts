// SPDX-License-Identifier: GPL-2.0-only
// Spectrum + waterfall renderer on two canvases sharing one frequency axis. Rows arrive straight from
// the socket (no React state); the spectrum redraws once per animation frame, the waterfall scrolls one
// device pixel per row.
import { channelsIn } from './channels';
import { TURBO } from './colormap';
import type { Row } from './protocol';

export type DisplayOpts = { dbMin: number; dbMax: number; wfMode: 'max' | 'avg'; wfPath: number; smooth: number };

const COLORS = ['#4fc3f7', '#ff8a65']; // path A, path B
const AXIS_W = 46; // px (CSS) reserved for the dB axis on the left
const AXIS_H = 22; // px (CSS) for the frequency axis under the spectrum

export class Display {
  private sp: HTMLCanvasElement;
  private wf: HTMLCanvasElement;
  private spCtx: CanvasRenderingContext2D;
  private wfCtx: CanvasRenderingContext2D;
  private last: (Row | null)[] = [null, null];
  private hold: (Float32Array | null)[] = [null, null];
  private dirty = false;
  private raf = 0;
  private hover: { x: number; y: number } | null = null;
  private dpr = 1;
  private seen = 0;
  // smooth: exponential averaging of the average trace across rows (0 = off .. 0.9 = heavy), like
  // gqrx's FFT averaging; the waterfall stays unsmoothed.
  opts: DisplayOpts = { dbMin: -110, dbMax: -20, wfMode: 'max', wfPath: 0, smooth: 0.7 };
  private smoothed: (Float32Array | null)[] = [null, null];
  onRetune: (freq: number) => void = () => {};

  constructor(sp: HTMLCanvasElement, wf: HTMLCanvasElement) {
    this.sp = sp;
    this.wf = wf;
    this.spCtx = sp.getContext('2d')!;
    this.wfCtx = wf.getContext('2d', { willReadFrequently: false })!;
    for (const c of [sp, wf]) {
      c.addEventListener('mousemove', (e) => {
        this.hover = { x: e.offsetX, y: c === sp ? e.offsetY : -1 };
        this.dirty = true;
      });
      c.addEventListener('mouseleave', () => {
        this.hover = null;
        this.dirty = true;
      });
      c.addEventListener('dblclick', (e) => {
        const f = this.freqAt(e.offsetX);
        if (f !== null) this.onRetune(Math.round(f / 1e5) * 1e5);
      });
    }
    const loop = () => {
      if (this.dirty) this.drawSpectrum();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.sp, this.wf]) {
      const w = Math.max(1, Math.round(c.clientWidth * this.dpr));
      const h = Math.max(1, Math.round(c.clientHeight * this.dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    this.wfCtx.fillStyle = '#000';
    this.wfCtx.fillRect(0, 0, this.wf.width, this.wf.height);
    this.dirty = true;
  }

  clear() {
    this.seen = 0;
    this.last = [null, null];
    this.hold = [null, null];
    this.smoothed = [null, null];
    this.wfCtx.fillStyle = '#000';
    this.wfCtx.fillRect(0, 0, this.wf.width, this.wf.height);
    this.dirty = true;
  }

  // A colour/plot range from the newest rows: a little under the noise floor (10th percentile of the
  // average) to a little over the strongest peak-hold value.
  suggestRange(): { dbMin: number; dbMax: number } | null {
    const r = this.last[0] ?? this.last[1];
    if (!r) return null;
    const sorted = Float32Array.from(r.avg).sort();
    const floor = sorted[Math.floor(sorted.length * 0.1)];
    let peak = -200;
    for (const h of this.hold) if (h) for (let i = 0; i < h.length; i++) peak = Math.max(peak, h[i]);
    const dbMin = Math.floor((floor - 8) / 5) * 5;
    const dbMax = Math.max(dbMin + 30, Math.ceil((peak + 5) / 5) * 5);
    return { dbMin, dbMax };
  }

  rowsSeen(): number {
    return this.seen;
  }

  setOpts(o: Partial<DisplayOpts>) {
    this.opts = { ...this.opts, ...o };
    this.dirty = true;
  }

  push(r: Row) {
    this.seen++;
    const prev = this.last[r.path];
    if (!prev || prev.bins !== r.bins || prev.f0 !== r.f0 || prev.df !== r.df) {
      this.hold[r.path] = null;
      this.smoothed[r.path] = null;
    }
    const sm = this.smoothed[r.path];
    const a = this.opts.smooth;
    if (!sm || a <= 0) this.smoothed[r.path] = Float32Array.from(r.avg);
    else for (let i = 0; i < r.bins; i++) sm[i] = a * sm[i] + (1 - a) * r.avg[i];
    this.last[r.path] = r;
    const h = this.hold[r.path];
    if (!h) this.hold[r.path] = Float32Array.from(r.max);
    else for (let i = 0; i < r.bins; i++) h[i] = Math.max(h[i] - 0.4, r.max[i]);
    if (r.path === this.opts.wfPath || !this.last[this.opts.wfPath]) this.drawWaterfallRow(r);
    this.dirty = true;
  }

  // frequency span shown (from the newest row)
  private span(): { f0: number; f1: number } | null {
    const r = this.last[0] ?? this.last[1];
    if (!r) return null;
    return { f0: r.f0 - r.df / 2, f1: r.f0 + r.df * (r.bins - 0.5) };
  }

  private plotLeft() { return AXIS_W * this.dpr; }

  private freqAt(cssX: number): number | null {
    const s = this.span();
    if (!s) return null;
    const x = cssX * this.dpr - this.plotLeft();
    const w = this.sp.width - this.plotLeft();
    if (x < 0 || x > w) return null;
    return s.f0 + (s.f1 - s.f0) * (x / w);
  }

  private drawWaterfallRow(r: Row) {
    const c = this.wfCtx, W = this.wf.width, H = this.wf.height, L = this.plotLeft();
    const w = W - L;
    if (w <= 0) return;
    c.drawImage(this.wf, L, 0, w, H - 1, L, 1, w, H - 1);
    const img = c.createImageData(w, 1);
    const px = new Uint32Array(img.data.buffer);
    const src = this.opts.wfMode === 'max' ? r.max : r.avg;
    const { dbMin, dbMax } = this.opts;
    const k = 255 / Math.max(1, dbMax - dbMin);
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x * r.bins) / w), b1 = Math.max(b0 + 1, Math.floor(((x + 1) * r.bins) / w));
      let v = -1e9;
      for (let b = b0; b < b1; b++) v = Math.max(v, src[b]);
      px[x] = TURBO[Math.max(0, Math.min(255, Math.round((v - dbMin) * k)))];
    }
    c.putImageData(img, L, 0);
  }

  private drawSpectrum() {
    this.dirty = false;
    const c = this.spCtx, W = this.sp.width, H = this.sp.height, d = this.dpr, L = this.plotLeft();
    const B = AXIS_H * d;
    const ph = H - B;
    c.fillStyle = '#0b0e13';
    c.fillRect(0, 0, W, H);
    const { dbMin, dbMax } = this.opts;
    const yOf = (db: number) => ph * (1 - (db - dbMin) / (dbMax - dbMin));
    c.font = `${11 * d}px system-ui, sans-serif`;
    c.textBaseline = 'middle';
    // dB grid
    const step = dbMax - dbMin > 60 ? 10 : 5;
    c.strokeStyle = '#1f2630';
    c.fillStyle = '#7d8896';
    c.lineWidth = 1;
    for (let db = Math.ceil(dbMin / step) * step; db <= dbMax; db += step) {
      const y = Math.round(yOf(db)) + 0.5;
      c.beginPath();
      c.moveTo(L, y);
      c.lineTo(W, y);
      c.stroke();
      c.textAlign = 'right';
      c.fillText(`${db}`, L - 6 * d, y);
    }
    const s = this.span();
    if (!s) {
      c.textAlign = 'center';
      c.fillText('no signal', (L + W) / 2, ph / 2);
      return;
    }
    const w = W - L;
    const xOf = (f: number) => L + ((f - s.f0) / (s.f1 - s.f0)) * w;
    // frequency grid + labels
    const spanMHz = (s.f1 - s.f0) / 1e6;
    const fstep = spanMHz > 30 ? 5 : spanMHz > 12 ? 2 : spanMHz > 6 ? 1 : 0.5;
    c.textAlign = 'center';
    for (let f = Math.ceil(s.f0 / 1e6 / fstep) * fstep; f <= s.f1 / 1e6; f += fstep) {
      const x = Math.round(xOf(f * 1e6)) + 0.5;
      c.strokeStyle = '#1f2630';
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, ph);
      c.stroke();
      c.fillStyle = '#7d8896';
      c.fillText(f.toFixed(fstep < 1 ? 1 : 0), x, ph + B / 2);
    }
    // Wi-Fi channel markers (20 MHz channels)
    c.fillStyle = '#5c6b7a';
    c.textBaseline = 'top';
    for (const ch of channelsIn(s.f0, s.f1)) {
      const x = Math.round(xOf(ch.centre)) + 0.5;
      c.strokeStyle = '#2b3a4a';
      c.setLineDash([3 * d, 3 * d]);
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, ph);
      c.stroke();
      c.setLineDash([]);
      c.fillText(`ch ${ch.label}`, x, 3 * d);
    }
    c.textBaseline = 'middle';
    // traces: max-hold (thin) then average
    for (let p = 0; p < 2; p++) {
      const r = this.last[p];
      if (!r) continue;
      const draw = (arr: Float32Array, alpha: number, lw: number) => {
        c.strokeStyle = COLORS[p];
        c.globalAlpha = alpha;
        c.lineWidth = lw * d;
        c.beginPath();
        const n = r.bins;
        for (let x = 0; x < w; x++) {
          const b0 = Math.floor((x * n) / w), b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / w));
          let v = -1e9;
          for (let b = b0; b < b1; b++) v = Math.max(v, arr[b]);
          const y = Math.max(0, Math.min(ph, yOf(v)));
          if (x === 0) c.moveTo(L + x, y);
          else c.lineTo(L + x, y);
        }
        c.stroke();
        c.globalAlpha = 1;
      };
      const h = this.hold[p];
      if (h) draw(h, 0.35, 1);
      draw(this.smoothed[p] ?? r.avg, 1, 1.2);
    }
    // hover readout
    if (this.hover) {
      const f = this.freqAt(this.hover.x);
      const r = this.last[0] ?? this.last[1];
      if (f !== null && r) {
        const x = this.hover.x * d;
        c.strokeStyle = '#e0e6ee';
        c.globalAlpha = 0.5;
        c.beginPath();
        c.moveTo(x + 0.5, 0);
        c.lineTo(x + 0.5, ph);
        c.stroke();
        c.globalAlpha = 1;
        const b = Math.max(0, Math.min(r.bins - 1, Math.round((f - r.f0) / r.df)));
        const txt = `${(f / 1e6).toFixed(3)} MHz   ${r.avg[b].toFixed(1)} dBFS`;
        c.font = `${12 * d}px system-ui, sans-serif`;
        const tw = c.measureText(txt).width + 12 * d;
        const tx = Math.min(W - tw, x + 8 * d);
        c.fillStyle = 'rgba(20,26,34,0.9)';
        c.fillRect(tx, 6 * d, tw, 20 * d);
        c.fillStyle = '#e0e6ee';
        c.textAlign = 'left';
        c.fillText(txt, tx + 6 * d, 16 * d);
      }
    }
  }
}
