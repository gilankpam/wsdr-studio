// SPDX-License-Identifier: GPL-2.0-only
// The band ruler's geometry (segments, channels, UNII groups) and its survey: per channel, the strongest
// peak seen over a row's noise floor (dB), kept for the session.
import type { Row } from './protocol';

export type Seg = { lo: number; hi: number; chans: number[]; half: number; label: (c: number, i: number) => string };
export const LOW: Seg = { lo: 2400e6, hi: 2484e6, chans: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], half: 2.4e6, label: (c) => ([1, 6, 11].includes(c) ? String(c) : '') };
export const HIGH: Seg = {
  lo: 5150e6, hi: 5895e6, half: 10e6, label: (c, i) => (i % 2 ? '' : String(c)),
  chans: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165, 169, 173, 177],
};
export const GROUPS: [string, number, number][] = [
  ['UNII-1', 5150e6, 5250e6], ['UNII-2', 5250e6, 5350e6], ['UNII-2e', 5470e6, 5730e6], ['UNII-3 / 5.9', 5730e6, 5895e6],
];
export const centre = (c: number) => (c <= 14 ? 2407e6 + 5e6 * c : 5000e6 + 5e6 * c);

export type Survey = Map<number, number>;
export function survey(s: Survey, r: Row) {
  const f0 = r.f0, f1 = r.f0 + r.df * (r.bins - 1);
  const sorted = Float32Array.from(r.avg).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  for (const seg of [LOW, HIGH])
    for (const c of seg.chans) {
      const fc = centre(c), half = seg === LOW ? 10e6 : 9e6; // a 2.4 GHz channel is 20 MHz wide too
      if (fc < f0 - 2e6 || fc > f1 + 2e6) continue; // its centre must be on the axis
      const b0 = Math.max(0, Math.ceil((fc - half - f0) / r.df)), b1 = Math.min(r.bins - 1, Math.floor((fc + half - f0) / r.df));
      let peak = -1e9;
      for (let b = b0; b <= b1; b++) peak = Math.max(peak, r.max[b]);
      if (b1 >= b0) s.set(c, Math.max(s.get(c) ?? 0, peak - floor));
    }
}
