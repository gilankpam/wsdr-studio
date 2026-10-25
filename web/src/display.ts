// SPDX-License-Identifier: GPL-2.0-only
// Spectrum + waterfall renderer on two canvases sharing one frequency axis. Rows arrive straight from
// the socket (no React state); the spectrum redraws once per animation frame, the waterfall scrolls one
// device pixel per row.
import { channelsIn } from './channels';
import { TURBO } from './colormap';
import type { Row } from './protocol';

export type DisplayOpts = {
  dbMin: number; dbMax: number; // spectrum scale (dBFS)
  wfFloor: number;              // the waterfall's colour scale starts here (dBFS; kept in dbMin..dbMax-10)
  wfMode: 'max' | 'avg';
  wfPath: number;
  smooth: number;               // 0 = off .. 0.9 = heavy averaging of the average trace across rows
  marker: number | null;        // requested frequency (Hz), drawn when it is not the band centre
  markerLabel: string;          // e.g. "requested" or "next Start"
  chipNotch: boolean;           // 8822C: shade its DC-rejection notch at the hardware centre
  badge: string | null;         // e.g. "GAPPED · ~12 % sampled", top right of the spectrum
  overlay: string | null;       // message over the plot (stopped, starting, ...)
  staleText: string;            // shown when rows stop arriving
  dim: boolean;                 // stopped: the last picture stays, faded
};

const AVG = ['#4fc3f7', '#ff8a65']; // average trace, path A / B
const PEAK = ['#8d99a8', '#c9a28f']; // peak trace, path A / B
const AXIS_W = 46; // CSS px reserved on the left (dB axis / colour bar + time ticks)
const AXIS_H = 22; // CSS px for the frequency axis under the spectrum
const TOP = 16;    // CSS px headroom above the spectrum (the "dBFS" caption sits there)
const STALE_MS = 1000;

export class Display {
  private sp: HTMLCanvasElement;
  private wf: HTMLCanvasElement;
  private spCtx: CanvasRenderingContext2D;
  private wfCtx: CanvasRenderingContext2D;
  private last: (Row | null)[] = [null, null];
  private hold: (Float32Array | null)[] = [null, null];
  private smoothed: (Float32Array | null)[] = [null, null];
  private wfSpan = '';
  private lastRowAt = 0;
  private lastRowT = 0;       // server time of the previous row (s)
  private rowsPerS = 25;      // measured row rate, for the waterfall's time ticks
  private gutterRate = 25;    // the rate the ticks were last drawn with
  private stopRows = -1;      // rows since the last Stop separator (-1: none); ticks end there
  private stopPending = false;
  private seen = 0;
  private dirty = true;
  private raf = 0;
  private hover: number | null = null; // CSS x
  private hoverWfY = -1;               // CSS y over the waterfall (-1: over the spectrum)
  private sepRows = -1;                // rows since the newest span separator (older rows: another span)
  private lastGen = -1;                // run byte of the newest row
  private genRows = 0;                 // rows of the current run
  private genCount = 0;                // run changes seen
  private frozen: HTMLCanvasElement | null = null; // waterfall before Stop dimmed it
  onHint: (text: string) => void = () => {};
  private dpr = 1;
  private off: (() => void)[] = [];
  opts: DisplayOpts = {
    dbMin: -110, dbMax: -20, wfFloor: -100, wfMode: 'max', wfPath: 0, smooth: 0.7, marker: null, markerLabel: 'requested', chipNotch: false, badge: null,
    overlay: null, staleText: 'No data from the adapter', dim: false,
  };
  onRetune: (freq: number) => void = () => {};

  constructor(sp: HTMLCanvasElement, wf: HTMLCanvasElement) {
    this.sp = sp;
    this.wf = wf;
    this.spCtx = sp.getContext('2d')!;
    this.wfCtx = wf.getContext('2d')!;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement, ev: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(ev, fn);
      this.off.push(() => el.removeEventListener(ev, fn));
    };
    for (const c of [sp, wf]) {
      on(c, 'mousemove', (e) => {
        this.hover = e.offsetX;
        this.hoverWfY = c === wf ? e.offsetY : -1;
        this.dirty = true;
      });
      on(c, 'mouseleave', () => {
        this.hover = null;
        this.dirty = true;
      });
    }
    // Tune by double-click on the spectrum only: older waterfall rows may belong to another span.
    on(sp, 'dblclick', (e) => {
      const f = this.freqAt(e.offsetX);
      if (f !== null) this.onRetune(f); // the app snaps it to the radio's tuning steps
    });
    on(wf, 'dblclick', () => this.onHint('Double-click the spectrum (top plot) to tune.'));
    let wasStale = false;
    const loop = () => {
      const stale = this.isStale();
      if (stale !== wasStale) {
        wasStale = stale;
        this.dirty = true;
      }
      if (this.dirty) this.drawSpectrum();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    for (const f of this.off) f();
    this.off = [];
  }

  private isStale() {
    return this.seen > 0 && performance.now() - this.lastRowAt > STALE_MS;
  }

  // Layout change (window resize, a strip appearing): keep the waterfall's history, rescaled to the
  // new width and anchored at the top (newest rows).
  resize() {
    const oldDpr = this.dpr;
    const oldFrozen = this.frozen;
    this.dpr = window.devicePixelRatio || 1;
    let keep: HTMLCanvasElement | null = null;
    const wf = this.wf;
    const w = Math.max(1, Math.round(wf.clientWidth * this.dpr)), h = Math.max(1, Math.round(wf.clientHeight * this.dpr));
    if ((wf.width !== w || wf.height !== h) && wf.width > 1 && wf.height > 1) {
      keep = document.createElement('canvas');
      keep.width = wf.width;
      keep.height = wf.height;
      keep.getContext('2d')!.drawImage(wf, 0, 0);
    }
    for (const c of [this.sp, wf]) {
      const cw = Math.max(1, Math.round(c.clientWidth * this.dpr));
      const ch = Math.max(1, Math.round(c.clientHeight * this.dpr));
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
    }
    this.wfCtx.fillStyle = '#000';
    this.wfCtx.fillRect(0, 0, wf.width, wf.height);
    const oL = AXIS_W * oldDpr, L = this.plotLeft();
    if (keep) {
      const rows = Math.min(keep.height, wf.height);
      this.wfCtx.drawImage(keep, oL, 0, keep.width - oL, rows, L, 0, wf.width - L, rows);
    }
    if (oldFrozen && keep) {
      // the undimmed Stop snapshot, rescaled the same way (Start puts it back)
      const f = document.createElement('canvas');
      f.width = wf.width;
      f.height = wf.height;
      const rows = Math.min(oldFrozen.height, wf.height);
      f.getContext('2d')!.drawImage(oldFrozen, oL, 0, oldFrozen.width - oL, rows, L, 0, wf.width - L, rows);
      this.frozen = f;
    }
    this.drawGutter();
    this.dirty = true;
  }

  // New stream (Start): forget the traces. The waterfall keeps its history below a separator.
  newStream() {
    if (this.frozen) {
      // undo Stop's dimming: the old rows keep their true colours (they matched the colour bar)
      this.wfCtx.drawImage(this.frozen, 0, 0);
      this.frozen = null;
    }
    this.seen = 0;
    this.lastGen = -1;
    this.genRows = 0;
    this.lastRowT = 0;
    this.last = [null, null];
    this.hold = [null, null];
    this.smoothed = [null, null];
    this.stopPending = !!this.wfSpan;
    this.dirty = true;
  }

  // Stream ended (Stop): keep the picture, faded, for a last look.
  freeze() {
    this.seen = 0; // not "stale": stopped on purpose
    this.frozen = document.createElement('canvas');
    this.frozen.width = this.wf.width;
    this.frozen.height = this.wf.height;
    this.frozen.getContext('2d')!.drawImage(this.wf, 0, 0);
    this.wfCtx.fillStyle = 'rgba(0,0,0,0.45)';
    const L = this.plotLeft();
    this.wfCtx.fillRect(L, 0, this.wf.width - L, this.wf.height);
    this.dirty = true;
  }

  hasPicture() {
    return !!(this.last[0] ?? this.last[1]);
  }

  // Forget the peak-hold (after a gain/frequency change it would describe the old setting).
  resetPeaks() {
    this.hold = [null, null];
    this.dirty = true;
  }

  // Drop one path's traces (e.g. after switching A+B -> A).
  dropPath(p: number) {
    this.last[p] = null;
    this.hold[p] = null;
    this.smoothed[p] = null;
    this.dirty = true;
  }

  setOpts(o: Partial<DisplayOpts>) {
    const rescale =
      o.dbMin !== undefined || o.dbMax !== undefined || o.wfFloor !== undefined || (o.dim !== undefined && o.dim !== this.opts.dim);
    this.opts = { ...this.opts, ...o };
    if (rescale) this.drawGutter();
    this.dirty = true;
  }

  rowsSeen() {
    return this.seen;
  }

  // Rows of the current stream run, and how many run changes have been seen (for Auto: refit on
  // rows of the NEW setting only).
  runRows() {
    return this.genRows;
  }
  runCount() {
    return this.genCount;
  }

  // Scales fitted to the signal: the spectrum from a little under the average noise floor to a little
  // over the strongest peak; the waterfall floor just above that noise floor.
  suggestRange(): { dbMin: number; dbMax: number; wfFloor: number } | null {
    const r = this.last[0] ?? this.last[1];
    if (!r) return null;
    const pct = (a: Float32Array, q: number) => Float32Array.from(a).sort()[Math.floor(a.length * q)];
    const floor = pct(r.avg, 0.1);
    // peak-hold (the app clears it when a setting changes, so it covers only the current setting)
    let peak = -200;
    for (const h of this.hold) if (h) for (let i = 0; i < h.length; i++) peak = Math.max(peak, h[i]);
    const dbMin = Math.floor((floor - 8) / 5) * 5;
    const dbMax = Math.max(dbMin + 30, Math.ceil((peak + 5) / 5) * 5);
    // Waterfall floor just above the average noise floor: rows with no frame at all (common: 40 ms
    // windows without traffic) then show dark blue, not black; frames stand out above them.
    // peak mode: the noise-only peak over a row sits ~7-8 dB above the average floor
    const wfFloor = Math.min(dbMax - 10, Math.max(dbMin, Math.round(floor + (this.opts.wfMode === 'max' ? 6 : 1))));
    return { dbMin, dbMax, wfFloor };
  }

  push(r: Row) {
    this.seen++;
    this.lastRowAt = performance.now();
    if (r.gen !== this.lastGen) {
      // a new run (tuning, gain, rate): peaks and averages of the old setting no longer apply
      if (this.lastGen >= 0) this.genCount++;
      this.lastGen = r.gen;
      this.genRows = 0;
      this.hold = [null, null];
      this.smoothed = [null, null];
    }
    this.genRows++;
    const shown = r.path === this.opts.wfPath || !this.last[this.opts.wfPath];
    if (this.lastRowT && r.t > this.lastRowT && shown) {
      const rate = 1 / (r.t - this.lastRowT);
      this.rowsPerS = 0.9 * this.rowsPerS + 0.1 * rate;
      if (Math.abs(this.rowsPerS - this.gutterRate) / this.gutterRate > 0.05) this.drawGutter();
    }
    if (shown) this.lastRowT = r.t;
    const prev = this.last[r.path];
    if (!prev || prev.bins !== r.bins || prev.f0 !== r.f0 || prev.df !== r.df) {
      this.hold[r.path] = null;
      this.smoothed[r.path] = null;
    }
    this.last[r.path] = r;
    const h = this.hold[r.path];
    if (!h) this.hold[r.path] = Float32Array.from(r.max);
    else for (let i = 0; i < r.bins; i++) h[i] = Math.max(h[i] - 0.4, r.max[i]);
    const sm = this.smoothed[r.path];
    const a = this.opts.smooth;
    if (!sm || a <= 0) this.smoothed[r.path] = Float32Array.from(r.avg);
    else for (let i = 0; i < r.bins; i++) sm[i] = a * sm[i] + (1 - a) * r.avg[i];
    if (r.path === this.opts.wfPath || !this.last[this.opts.wfPath]) this.drawWaterfallRow(r);
    this.dirty = true;
  }

  private span(): { f0: number; f1: number } | null {
    const r = this.last[0] ?? this.last[1];
    if (!r) return null;
    return { f0: r.f0 - r.df / 2, f1: r.f0 + r.df * (r.bins - 0.5) };
  }

  private plotLeft() {
    return AXIS_W * this.dpr;
  }

  private freqAt(cssX: number): number | null {
    const s = this.span();
    if (!s) return null;
    const x = cssX * this.dpr - this.plotLeft();
    const w = this.sp.width - this.plotLeft();
    if (x < 0 || x > w) return null;
    return s.f0 + (s.f1 - s.f0) * (x / w);
  }

  private wfLo() {
    return Math.min(this.opts.dbMax - 10, Math.max(this.opts.dbMin, this.opts.wfFloor));
  }

  // The floor maps to a dark blue (index 30), not black: rows without any frame stay visible as
  // "quiet", and only values well under the floor fade to black.
  private colour(db: number) {
    const lo = this.wfLo(), hi = this.opts.dbMax;
    return TURBO[Math.max(0, Math.min(255, Math.round(30 + ((db - lo) * 225) / Math.max(1, hi - lo))))];
  }

  // Left gutter of the waterfall: colour bar (scale) and time ticks.
  private drawGutter() {
    const c = this.wfCtx, d = this.dpr, H = this.wf.height, L = this.plotLeft();
    c.fillStyle = '#0b0e13';
    c.fillRect(0, 0, L, H);
    const lo = this.wfLo(), hi = this.opts.dbMax;
    const barW = Math.round(6 * d), barH = Math.min(H - 20 * d, 160 * d), y0 = 6 * d;
    if (barH > 10) {
      const img = c.createImageData(barW, Math.round(barH));
      const px = new Uint32Array(img.data.buffer);
      for (let y = 0; y < img.height; y++) {
        const v = TURBO[Math.round(255 - (225 * y) / Math.max(1, img.height - 1))]; // as colour(): floor = 30
        for (let x = 0; x < barW; x++) px[y * barW + x] = v;
      }
      c.putImageData(img, Math.round(4 * d), Math.round(y0));
    }
    c.fillStyle = '#7d8896';
    c.font = `${10 * d}px system-ui, sans-serif`;
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(`${Math.round(hi)}`, 13 * d, y0);
    c.textBaseline = 'bottom';
    c.fillText(`${Math.round(lo)}`, 13 * d, y0 + barH - 10 * d);
    c.fillText('floor', 13 * d, y0 + barH);
    // time ticks: one row = one device pixel, at the measured row rate
    const pxPerS = this.rowsPerS;
    this.gutterRate = pxPerS;
    const step = pxPerS * 10 > 60 * d ? 10 : 30;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    // no ticks across a Stop gap, nor while stopped (the picture's age keeps growing)
    const end = this.opts.dim ? 0 : this.stopRows >= 0 ? Math.min(H, this.stopRows) : H;
    for (let s = step; s * pxPerS < end; s += step) {
      const y = s * pxPerS;
      if (y < y0 + barH + 12 * d) continue;
      c.fillRect(L - 5 * d, y, 4 * d, 1);
      c.fillText(`−${s} s`, L - 7 * d, y);
    }
  }

  private drawWaterfallRow(r: Row) {
    const c = this.wfCtx, W = this.wf.width, H = this.wf.height, L = this.plotLeft();
    const w = W - L;
    if (w <= 0) return;
    c.drawImage(this.wf, L, 0, w, H - 1, L, 1, w, H - 1);
    if (this.sepRows >= 0) this.sepRows++;
    if (this.stopRows >= 0) {
      this.stopRows++;
      if (this.stopRows <= H) this.drawGutter();
    }
    const span = `${((r.f0 + r.df * (r.bins / 2 - 0.5)) / 1e6).toFixed(1)} MHz · ${+((r.df * r.bins) / 1e6).toFixed(1)} MHz span${r.gapped ? ' · gapped' : ''}`;
    if (this.wfSpan && (span !== this.wfSpan || this.stopPending)) {
      // A retune, span change or new run: a separator. The label describes the OLD rows below it (the
      // new rows above match the axis), so nothing below the line is misread.
      const d = this.dpr;
      const label = this.stopPending
        ? span === this.wfSpan
          ? '▼ Stop (gap)' // same tuning: only the time gap needs marking
          : `▼ before Stop: ${this.wfSpan} (not on this axis)`
        : `▼ before: ${this.wfSpan} (not on this axis)`;
      if (this.stopPending) this.stopRows = 0;
      if (span !== this.wfSpan) this.sepRows = 0; // a Stop at the same span keeps the frequency axis
      this.stopPending = false;
      c.fillStyle = '#ffffff';
      c.fillRect(L, 0, w, Math.max(1, Math.round(d)));
      c.font = `${11 * d}px system-ui, sans-serif`;
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillStyle = 'rgba(0,0,0,0.65)';
      c.fillRect(L + 4 * d, 2 * d, c.measureText(label).width + 8 * d, 15 * d);
      c.fillStyle = '#ffffff';
      c.fillText(label, L + 8 * d, 4 * d);
      this.wfSpan = span;
      return;
    }
    this.wfSpan = span;
    const img = c.createImageData(w, 1);
    const px = new Uint32Array(img.data.buffer);
    const src = this.opts.wfMode === 'max' ? r.max : r.avg;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((x * r.bins) / w), b1 = Math.max(b0 + 1, Math.floor(((x + 1) * r.bins) / w));
      let v = -1e9;
      for (let b = b0; b < b1; b++) v = Math.max(v, src[b]);
      px[x] = this.colour(v);
    }
    c.putImageData(img, L, 0);
  }

  private drawSpectrum() {
    this.dirty = false;
    const c = this.spCtx, W = this.sp.width, H = this.sp.height, d = this.dpr, L = this.plotLeft();
    const B = AXIS_H * d, T = TOP * d;
    const ph = H - B;
    c.fillStyle = '#0b0e13';
    c.fillRect(0, 0, W, H);
    const { dbMin, dbMax } = this.opts;
    const yOf = (db: number) => T + (ph - T) * (1 - (db - dbMin) / (dbMax - dbMin));
    c.font = `${11 * d}px system-ui, sans-serif`;
    c.textBaseline = 'middle';
    // dB grid + axis caption
    const step = dbMax - dbMin > 60 ? 10 : 5;
    c.strokeStyle = '#1f2630';
    c.fillStyle = '#7d8896';
    c.lineWidth = 1;
    c.textAlign = 'right';
    for (let db = Math.ceil(dbMin / step) * step; db <= dbMax; db += step) {
      const y = Math.round(yOf(db)) + 0.5;
      c.beginPath();
      c.moveTo(L, y);
      c.lineTo(W, y);
      c.stroke();
      c.fillText(`${db}`, L - 6 * d, y);
    }
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('dBFS', 4 * d, 1 * d);
    c.textBaseline = 'middle';
    const s = this.span();
    const stale = this.isStale();
    if (s) {
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
        c.moveTo(x, T);
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
        c.moveTo(x, T);
        c.lineTo(x, ph);
        c.stroke();
        c.setLineDash([]);
        c.fillText(`ch ${ch.label}`, x, T + 2 * d);
      }
      // 8822C: its RX DC rejection leaves a notch at the hardware centre (in the raw samples; ~-6 dB at
      // +-1.5 % of fs). Shade it so it is not read as a missing signal.
      const mid0 = (s.f0 + s.f1) / 2;
      if (this.opts.chipNotch) {
        const hw = (s.f1 - s.f0) * 0.015;
        const x0 = xOf(mid0 - hw), x1 = xOf(mid0 + hw);
        if (x1 - x0 >= 3 * d) {
          c.fillStyle = 'rgba(160,170,190,0.10)';
          c.fillRect(x0, T, x1 - x0, ph - T);
          c.font = `${10 * d}px system-ui, sans-serif`;
          c.fillStyle = '#8a95a5';
          c.textAlign = 'center';
          c.textBaseline = 'top';
          c.fillText('chip notch (not a signal)', (x0 + x1) / 2, T + 30 * d);
          c.textBaseline = 'middle';
        }
      }
      // requested frequency, when the hardware centre differs (5 MHz synthesizer grid)
      const m = this.opts.marker;
      const mid = (s.f0 + s.f1) / 2;
      if (m !== null && m > s.f0 && m < s.f1 && Math.abs(m - mid) > (s.f1 - s.f0) / 200) {
        const x = Math.round(xOf(m)) + 0.5;
        c.strokeStyle = '#ffd54f';
        c.setLineDash([6 * d, 4 * d]);
        c.beginPath();
        c.moveTo(x, T);
        c.lineTo(x, ph);
        c.stroke();
        c.setLineDash([]);
        const label = `${this.opts.markerLabel} ${(m / 1e6).toFixed(1)}`;
        c.font = `${11 * d}px system-ui, sans-serif`;
        const lw = c.measureText(label).width;
        const lx = Math.min(W - lw - 4 * d, Math.max(L + 2 * d, x - lw / 2));
        c.fillStyle = 'rgba(11,14,19,0.85)';
        c.fillRect(lx - 3 * d, ph - 18 * d, lw + 6 * d, 15 * d);
        c.fillStyle = '#ffd54f';
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillText(label, lx, ph - 16 * d);
        c.textBaseline = 'middle';
      }
      c.globalAlpha = stale || this.opts.dim ? 0.35 : 1;
      for (let p = 0; p < 2; p++) {
        const r = this.last[p];
        if (!r) continue;
        const draw = (arr: Float32Array, colour: string, lw: number) => {
          c.strokeStyle = colour;
          c.lineWidth = lw * d;
          c.beginPath();
          const n = r.bins;
          for (let x = 0; x < w; x++) {
            const b0 = Math.floor((x * n) / w), b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / w));
            let v = -1e9;
            for (let b = b0; b < b1; b++) v = Math.max(v, arr[b]);
            const y = Math.max(T, Math.min(ph, yOf(v)));
            if (x === 0) c.moveTo(L + x, y);
            else c.lineTo(L + x, y);
          }
          c.stroke();
        };
        const h = this.hold[p];
        if (h) draw(h, PEAK[p], 1);
        draw(this.smoothed[p] ?? r.avg, AVG[p], 1.3);
      }
      c.globalAlpha = 1;
      // legend
      const both = !!(this.last[0] && this.last[1]);
      const pa = this.last[0] ? 0 : 1;
      const items: [string, string][] = both
        ? [['A average', AVG[0]], ['B average', AVG[1]], ['peak', PEAK[0]]]
        : [['average', AVG[pa]], ['peak', PEAK[pa]]];
      c.font = `${11 * d}px system-ui, sans-serif`;
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      let lx = W - 8 * d;
      for (let i = items.length - 1; i >= 0; i--) {
        const [label, col] = items[i];
        lx -= c.measureText(label).width + 26 * d;
        c.fillStyle = col;
        c.fillRect(lx, T + 18 * d, 14 * d, 2 * d);
        c.fillStyle = '#aab4c0';
        c.fillText(label, lx + 18 * d, T + 19 * d);
      }
      // badge (gapped runs): on the plot itself, not only in the footer
      if (this.opts.badge) {
        c.font = `bold ${11 * d}px system-ui, sans-serif`;
        const bw = c.measureText(this.opts.badge).width + 12 * d;
        c.fillStyle = 'rgba(255,183,77,0.16)';
        c.fillRect(W - bw - 8 * d, T + 30 * d, bw, 18 * d);
        c.fillStyle = '#ffb74d';
        c.textAlign = 'left';
        c.fillText(this.opts.badge, W - bw - 2 * d, T + 39 * d);
      }
      // hover readout
      if (this.hover !== null && !stale) {
        const f = this.freqAt(this.hover);
        const r = this.last[0] ?? this.last[1];
        if (f !== null && r) {
          const x = this.hover * d;
          c.strokeStyle = '#e0e6ee';
          c.globalAlpha = 0.5;
          c.beginPath();
          c.moveTo(x + 0.5, T);
          c.lineTo(x + 0.5, ph);
          c.stroke();
          c.globalAlpha = 1;
          const b = Math.max(0, Math.min(r.bins - 1, Math.round((f - r.f0) / r.df)));
          const sm = this.smoothed[r.path] ?? r.avg;
          const pk = this.hold[r.path] ?? r.max;
          // over the waterfall: frequency and age (the levels shown live are not that row's)
          const wy = this.hoverWfY * d;
          const older = this.hoverWfY >= 0 && this.sepRows >= 0 && wy > this.sepRows;
          const beforeStop = this.hoverWfY >= 0 && (this.opts.dim || (this.stopRows >= 0 && wy > this.stopRows));
          const txt = older
            ? 'older rows: another frequency/span (see the label at the line)'
            : this.hoverWfY >= 0
              ? `${(f / 1e6).toFixed(3)} MHz · ${beforeStop ? 'before Stop' : `${(wy / this.rowsPerS).toFixed(1)} s ago`}`
              : `${(f / 1e6).toFixed(3)} MHz · avg ${sm[b].toFixed(1)} · peak ${pk[b].toFixed(1)} dBFS`;
          c.font = `${12 * d}px system-ui, sans-serif`;
          const tw = c.measureText(txt).width + 12 * d;
          const tx = Math.min(W - tw, x + 8 * d);
          // over the waterfall: just above the frequency axis (nearest the pointer); else below any overlay
          const ty = this.hoverWfY >= 0 ? ph - 44 * d : T + (this.opts.overlay ? 72 : 30) * d; // clear of the marker label
          c.fillStyle = 'rgba(20,26,34,0.92)';
          c.fillRect(tx, ty, tw, 20 * d);
          c.fillStyle = '#e0e6ee';
          c.textAlign = 'left';
          c.fillText(txt, tx + 6 * d, ty + 10 * d);
        }
      }
    }
    // overlay message: explicit (stopped/starting) or stale data
    const msg = this.opts.overlay ?? (stale ? this.opts.staleText : null);
    if (msg) {
      c.font = `${14 * d}px system-ui, sans-serif`;
      const tw = c.measureText(msg).width + 28 * d;
      const cx = (L + W) / 2, cy = T + 48 * d; // near the top: the traces stay visible below it
      c.fillStyle = 'rgba(19,24,32,0.92)';
      c.fillRect(cx - tw / 2, cy - 16 * d, tw, 32 * d);
      c.fillStyle = '#d6dde6';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(msg, cx, cy);
    }
  }
}
