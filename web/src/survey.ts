// SPDX-License-Identifier: GPL-2.0-only
// The band ruler's geometry (segments, channels, UNII groups) and its survey: per channel, the strongest
// peak seen over the noise (dB), kept for the session.
import type { Row } from './protocol';

export type Seg = { lo: number; hi: number; chans: number[]; half: number; label: (c: number, i: number) => string };
export const LOW: Seg = { lo: 2400e6, hi: 2484e6, chans: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], half: 2.5e6, label: (c) => ([1, 6, 11].includes(c) ? String(c) : '') };
export const HIGH: Seg = {
  lo: 5150e6, hi: 5895e6, half: 10e6, label: (c, i) => (i % 2 ? '' : String(c)),
  chans: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165, 169, 173, 177],
};
export const GROUPS: [string, number, number][] = [
  ['UNII-1', 5150e6, 5250e6], ['UNII-2', 5250e6, 5350e6], ['UNII-2e', 5470e6, 5730e6], ['UNII-3 / 5.9', 5730e6, 5895e6],
];
export const centre = (c: number) => (c <= 14 ? 2407e6 + 5e6 * c : 5000e6 + 5e6 * c);

export type Survey = Map<number, number>;
// Each cell's own slice (2.4 GHz: its 5 MHz, so one AP does not light up nine overlapping channels;
// 5 GHz: its 20 MHz channel). Peak-hold against the peak-hold's median over the central 80 % of the
// span (the edges roll off, a chip notch dips): noise alone reads ~0 dB.
export function survey(s: Survey, r: Row) {
  const f0 = r.f0, f1 = r.f0 + r.df * (r.bins - 1);
  const a = Math.floor(r.bins * 0.1), n = Math.floor(r.bins * 0.8), stride = Math.max(1, Math.floor(n / 512));
  const sample: number[] = [];
  for (let i = a; i < a + n; i += stride) sample.push(r.max[i]);
  sample.sort((x, y) => x - y);
  const floor = sample[Math.floor(sample.length / 2)];
  for (const seg of [LOW, HIGH])
    for (const c of seg.chans) {
      const fc = centre(c), half = seg === LOW ? seg.half : 9e6;
      if (fc < f0 - 1e6 || fc > f1 + 1e6) continue; // its centre must be on the axis
      const b0 = Math.max(0, Math.ceil((fc - half - f0) / r.df)), b1 = Math.min(r.bins - 1, Math.floor((fc + half - f0) / r.df));
      let peak = -1e9;
      for (let b = b0; b <= b1; b++) peak = Math.max(peak, r.max[b]);
      if (b1 >= b0) s.set(c, Math.max(s.get(c) ?? 0, peak - floor));
    }
}

// The tint: teal (amber means a warning in this app), stronger with more dB over the noise.
export const tint = (db: number | undefined) =>
  db === undefined ? undefined : `rgba(77, 182, 172, ${(0.12 + 0.6 * Math.min(1, Math.max(0, (db - 3) / 27))).toFixed(2)})`;
