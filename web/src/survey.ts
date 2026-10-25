// SPDX-License-Identifier: GPL-2.0-only
// The band ruler's survey: per channel, the strongest peak seen over the noise (dB), kept for the
// session.
import type { Row } from './protocol';

// the channels surveyed, with a cell's half-width
type Seg = { chans: number[]; half: number };
const LOW: Seg = { chans: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], half: 2.5e6 };
const HIGH: Seg = {
  half: 10e6,
  chans: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165, 169, 173, 177],
};
export const centre = (c: number) => (c <= 14 ? 2407e6 + 5e6 * c : 5000e6 + 5e6 * c);

export type Survey = Map<number, number>;
// Each cell's own slice (2.4 GHz: its 5 MHz, so one AP does not light up nine overlapping channels;
// 5 GHz: its 20 MHz channel). The slice's peak against the noise of a slice as wide: the median of the
// peaks of equal-width windows over the central 80 % of the span (the edges roll off, a notch dips),
// so noise alone reads ~0 dB whatever the width. A cell counts once two surveyed rows in a row show
// the same excess (a lone noise spike does not), so the tint does not creep up over a session.
const pending = new WeakMap<Survey, Map<number, number>>();
export function survey(s: Survey, r: Row) {
  if (r.bins < 16) return;
  const f0 = r.f0, f1 = r.f0 + r.df * (r.bins - 1);
  const floors = new Map<number, number>(); // window width (bins) -> noise
  const floorFor = (n: number) => {
    let v = floors.get(n);
    if (v !== undefined) return v;
    const a = Math.floor(r.bins * 0.1), end = Math.floor(r.bins * 0.9), peaks: number[] = [];
    const step = Math.max(n, Math.floor((end - a) / 256)); // at most ~256 windows
    for (let i = a; i + n <= end; i += step) {
      let p = -1e9;
      for (let b = i; b < i + n; b++) p = Math.max(p, r.max[b]);
      peaks.push(p);
    }
    peaks.sort((x, y) => x - y);
    v = peaks.length ? peaks[Math.floor(peaks.length / 2)] : -1e9;
    floors.set(n, v);
    return v;
  };
  let prev = pending.get(s);
  if (!prev) pending.set(s, (prev = new Map()));
  for (const seg of [LOW, HIGH])
    for (const c of seg.chans) {
      const fc = centre(c), half = seg === LOW ? seg.half : 9e6;
      if (fc < f0 - 1e6 || fc > f1 + 1e6) continue; // its centre must be on the axis
      const b0 = Math.max(0, Math.ceil((fc - half - f0) / r.df)), b1 = Math.min(r.bins - 1, Math.floor((fc + half - f0) / r.df));
      if (b1 < b0) continue;
      let peak = -1e9;
      for (let b = b0; b <= b1; b++) peak = Math.max(peak, r.max[b]);
      const floor = floorFor(Math.min(b1 - b0 + 1, Math.floor(r.bins * 0.8)));
      if (floor <= -1e9) continue;
      const now = peak - floor, before = prev.get(c);
      prev.set(c, now);
      if (before !== undefined) s.set(c, Math.max(s.get(c) ?? 0, Math.min(now, before)));
    }
}

// The ruler shows it as a bar under each cell (neutral: cyan and purple are the views, amber warns),
// stronger with more dB over the noise: 0 at ~3 dB, 1 at 30 dB.
export const level = (db: number) => Math.min(1, Math.max(0, (db - 3) / 27));
