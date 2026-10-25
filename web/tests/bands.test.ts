// SPDX-License-Identifier: GPL-2.0-only
// The band ruler's channel axis, the Spectral Map's sweep plans and the channel survey.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RANGES, freqAt, pos, sweepPlan, type Range } from '../src/bands';
import type { Device, Row } from '../src/protocol';
import { centre, survey } from '../src/survey';

const ranges = Object.keys(RANGES) as Range[];
const dev = (max_msps: number, gapped_msps = 0, pid = 0xb812): Device => ({
  pid, model: 'RTL8812BU', chip: 'RTL8822B', bus: 6, port: '1', speed_mbps: max_msps >= 40 ? 5000 : 480,
  controller: '', driver: 'usbfs', can_open: true, max_msps, gapped_msps,
});

test('the axis: freqAt and pos are inverse and in order', () => {
  for (const r of ranges) {
    let last = -1;
    for (let i = 0; i <= 200; i++) {
      const x = i / 200, f = freqAt(r, x);
      assert.ok(Math.abs(pos(r, f) - x) < 1e-9, `${r}: pos(freqAt(${x}))`);
      assert.ok(f >= last, `${r}: frequencies rise along the axis`);
      last = f;
    }
  }
});

test('the axis: every channel cell is equally wide within a range', () => {
  for (const r of ranges)
    for (const g of RANGES[r].groups) {
      const w = g.chans.map((c) => pos(r, centre(c) + g.half) - pos(r, centre(c) - g.half));
      for (const x of w) assert.ok(Math.abs(x - w[0]) < 1e-9, `${r}/${g.name}: cells alike`);
    }
});

test('sweep plans: every channel MHz inside a step, centres unique and tunable, gapped only when allowed', () => {
  const cases: [string, Device, boolean][] = [
    ['8812BU on USB 3', dev(40), false],
    ['8812BU on USB 2', dev(5, 40), false],
    ['8812BU on USB 2, gapped allowed', dev(5, 40), true],
  ];
  for (const [name, d, gappedOk] of cases)
    for (const r of ranges) {
      const p = sweepPlan(r, d, gappedOk)!;
      assert.equal(new Set(p.centres).size, p.centres.length, `${name} ${r}: unique centres`);
      assert.equal(p.gapped, gappedOk && d.max_msps < 40, `${name} ${r}: gapped only when allowed`);
      assert.equal(80e6 / (1 << p.rate_sel), p.fs, `${name} ${r}: rate matches the span`);
      if (p.fs >= 40e6)
        for (const c of p.centres) assert.ok(c < 3.7e9 ? c >= 2422e6 && c <= 2462e6 : c >= 5090e6 && c <= 6155e6, `${name} ${r}: ${c / 1e6} tunable at 40 MHz`);
      // a margin inside the capture where the filter is flat (none for 5 MHz steps: they only abut)
      const margin = p.fs >= 20e6 ? 1e6 : 0;
      for (const g of RANGES[r].groups)
        for (let f = centre(g.chans[0]) - g.half + 0.5e6; f < centre(g.chans[g.chans.length - 1]) + g.half; f += 1e6)
          assert.ok(p.centres.some((c) => Math.abs(f - c) <= p.fs / 2 - margin && Math.abs(f - c) <= p.step / 2 + 2.5e6), `${name} ${r}: ${f / 1e6} MHz heard`);
    }
});

test('sweep plans: no adapter, no plan', () => {
  assert.equal(sweepPlan('5', undefined, false), null);
});

// a row of 8192 bins at 40 MS/s around `c`, noise at -80 dBFS (+-1 dB), plus flat blocks
const row = (c: number, blocks: [number, number, number][] = [], gen = 0): Row => {
  const bins = 8192, df = 40e6 / bins, f0 = c - 20e6 + df / 2;
  const avg = new Float32Array(bins), max = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const f = f0 + i * df;
    let v = -80 + Math.sin(i * 12.9898) * 1; // deterministic ripple
    for (const [lo, hi, db] of blocks) if (f >= lo && f <= hi) v = Math.max(v, db);
    avg[i] = v - 5;
    max[i] = v;
  }
  return { slot: 0, path: 0, gapped: false, offset: false, gen, seq: 0, bins, t: 0, f0, df, avg, max };
};

test('survey: noise alone stays near 0 dB; a channel with a signal stands out', () => {
  const s = new Map<number, number>();
  for (let i = 0; i < 4; i++) survey(s, Object.assign(row(5190e6, [[5172e6, 5188e6, -50]]), { t: i * 0.2 }));
  assert.ok((s.get(36) ?? 0) > 20, `ch 36 with a -50 dBFS block: ${s.get(36)}`);
  assert.ok((s.get(44) ?? 0) < 6, `ch 44, noise only: ${s.get(44)}`);
});

test('survey: one row alone does not count (two rows must agree)', () => {
  const s = new Map<number, number>();
  survey(s, row(5190e6, [[5172e6, 5188e6, -50]]));
  assert.equal(s.get(36), undefined);
});
