// SPDX-License-Identifier: GPL-2.0-only
// The band ruler: one range at a time at full width (2.4 GHz, a 5 GHz section, or all of 5 GHz; it
// follows the selected view), a cell per channel (click: tune the selected view there), a bracket per
// view at the span it shows (its tab selects the view), and a survey bar: the strongest signal seen on
// each channel this session. 5 GHz channels are equally wide, laid out by channel, not by MHz: the gaps
// between the UNII groups (where nothing is allowed) shrink to short breaks.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { centre, level, type Survey } from './survey';
import { SLOT_NAME, VIEW_COLOUR, bandOf, mhz } from './util';

type Range = '2.4' | '5' | 'u12' | 'u2e' | 'u3';
type Group = { name: string; chans: number[]; half: number }; // half: a cell's half-width (Hz)
// A piece of the axis: frequencies f0..f1 drawn over units u0..u1 (one unit = one cell).
type Piece = { f0: number; f1: number; u0: number; u1: number };
const U1: Group = { name: 'UNII-1', chans: [36, 40, 44, 48], half: 10e6 };
const U2: Group = { name: 'UNII-2', chans: [52, 56, 60, 64], half: 10e6 };
const U2E: Group = { name: 'UNII-2e', chans: [100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144], half: 10e6 };
const U3: Group = { name: 'UNII-3', chans: [149, 153, 157, 161, 165], half: 10e6 };
const U59: Group = { name: '5.9 GHz', chans: [169, 173, 177], half: 10e6 };
// edge: the frequencies the range covers (the radio tunes 2.4 GHz and 5080-6165 MHz)
const RANGES: Record<Range, { label: string; title: string; groups: Group[]; edge: [number, number] }> = {
  '2.4': { label: '2.4 GHz', title: 'Channels 1–13 (2400–2483.5 MHz)', groups: [{ name: '', chans: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], half: 2.5e6 }], edge: [2400e6, 2490e6] },
  '5': { label: '5 GHz', title: 'All 5 GHz channels', groups: [U1, U2, U2E, U3, U59], edge: [5080e6, 6165e6] },
  u12: { label: '36–64', title: 'Channels 36–64: UNII-1 and UNII-2 (5150–5350 MHz)', groups: [U1, U2], edge: [5080e6, 5410e6] },
  u2e: { label: '100–144', title: 'Channels 100–144: UNII-2e (5470–5730 MHz)', groups: [U2E], edge: [5410e6, 5732.5e6] },
  u3: { label: '149–177', title: 'Channels 149–177: UNII-3 and 5.9 GHz (5735–5895 MHz)', groups: [U3, U59], edge: [5732.5e6, 6165e6] },
};
// the section a frequency is in (5 GHz: the one around it, not the whole band)
const rangeOf = (f: number): Range => (f < 3.7e9 ? '2.4' : f < 5410e6 ? 'u12' : f < 5732.5e6 ? 'u2e' : 'u3');
const BREAK = 0.6; // units for a gap between groups (or a range edge), whatever its MHz

// The axis of a range: groups at one unit per cell, gaps and edges as short breaks.
function axis(range: Range): { pieces: Piece[]; units: number } {
  const pieces: Piece[] = [];
  const { groups, edge } = RANGES[range];
  let u = 0, f = edge[0];
  for (const g of groups) {
    const lo = centre(g.chans[0]) - g.half, hi = centre(g.chans[g.chans.length - 1]) + g.half;
    if (lo > f) {
      const w = Math.min(BREAK, (lo - f) / (2 * g.half));
      pieces.push({ f0: f, f1: lo, u0: u, u1: u + w });
      u += w;
    }
    pieces.push({ f0: lo, f1: hi, u0: u, u1: u + g.chans.length });
    u += g.chans.length;
    f = hi;
  }
  if (edge[1] > f) {
    const w = Math.min(BREAK, (edge[1] - f) / (2 * groups[groups.length - 1].half));
    pieces.push({ f0: f, f1: edge[1], u0: u, u1: u + w });
    u += w;
  }
  return { pieces, units: u };
}
const AXES = Object.fromEntries((Object.keys(RANGES) as Range[]).map((r) => [r, axis(r)])) as Record<Range, ReturnType<typeof axis>>;
// position of a frequency on a range's axis, 0..1 (clamped to its ends)
function pos(band: Range, f: number) {
  const { pieces, units } = AXES[band];
  const p = pieces.find((x) => f <= x.f1) ?? pieces[pieces.length - 1];
  const t = Math.min(1, Math.max(0, (f - p.f0) / (p.f1 - p.f0)));
  return Math.min(units, Math.max(0, p.u0 + t * (p.u1 - p.u0))) / units;
}
function freqAt(band: Range, x: number) {
  const { pieces, units } = AXES[band];
  const u = x * units;
  const p = pieces.find((q) => u <= q.u1) ?? pieces[pieces.length - 1];
  return p.f0 + ((u - p.u0) / (p.u1 - p.u0)) * (p.f1 - p.f0);
}
const pc = (x: number) => `${(x * 100).toFixed(3)}%`;
const bar = (lv: number) => ({ opacity: (0.25 + 0.75 * lv).toFixed(2), width: `${Math.round(30 + 70 * lv)}%` });
const WHEEL_PX = 50; // wheel distance per 5 MHz step (a notch is ~50-120 px; trackpads send many small ones)
const WHEEL_MAX = 4; // steps per burst at most
const LABEL_PX = 26; // room a channel number needs
const FREQ_PX = 60;  // room for the channel's MHz under it too

export type RulerView = { slot: number; lo: number; hi: number; locked: boolean; gapped: boolean };

export function BandRuler(p: {
  views: RulerView[]; sel: number; compact: boolean; survey: Survey; linkLabel: string | null; otherBusy: string | null;
  onTune: (f: number) => void; onStep: (steps: number) => void; onSelect: (slot: number) => void;
}) {
  const wheel = useRef({ px: 0, t: 0 });
  const track = useRef<HTMLDivElement>(null);
  const [trackPx, setTrackPx] = useState(800);
  // the survey grows in place: redraw it once a second (not the whole window)
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    const w = wheel.current;
    return () => {
      window.clearInterval(t);
      window.clearTimeout(w.t);
    };
  }, []);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackPx(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const selView = p.views.find((v) => v.slot === p.sel);
  const selLocked = selView?.locked ?? true;
  // the range shown: the selected view's section, unless the user picked another (until that view
  // moves to another section)
  const selRange = selView ? rangeOf((selView.lo + selView.hi) / 2) : 'u12';
  const [picked, setPicked] = useState<{ range: Range; from: Range } | null>(null);
  // another view selected, or it moved to another section: follow it again (state adjusted in render)
  const [seen, setSeen] = useState(`${p.sel}:${selRange}`);
  if (seen !== `${p.sel}:${selRange}`) {
    setSeen(`${p.sel}:${selRange}`);
    setPicked(null);
  }
  const band: Range = picked && picked.from === selRange ? picked.range : selRange;
  const showBand = (b: Range) => setPicked(b === selRange ? null : { range: b, from: selRange });
  const shows = (v: RulerView) => {
    const c = (v.lo + v.hi) / 2;
    return band === '5' ? bandOf(c) === '5' : rangeOf(c) === band;
  };

  const onWheel = (e: WheelEvent) => {
    if (selLocked || !e.deltaY) return;
    const w = wheel.current;
    w.px += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    window.clearTimeout(w.t);
    w.t = window.setTimeout(() => {
      // one retune for a burst (down: lower); a short flick is still one step
      const n = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, -Math.trunc(w.px / WHEEL_PX) || -Math.sign(w.px)));
      w.px = 0;
      p.onStep(n);
    }, 150);
  };
  const onKey = (e: KeyboardEvent) => {
    if (selLocked || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    p.onStep((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 4 : 1));
  };
  const at = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return freqAt(band, (e.clientX - r.left) / r.width);
  };
  const { units } = AXES[band];
  const cellPx = trackPx / units;
  // label every channel when they fit, else every 2nd or 4th (2.4 GHz: 1, 6, 11 when tight)
  const every = band === '2.4' ? (cellPx >= LABEL_PX * 0.8 ? 1 : 5) : cellPx >= LABEL_PX ? 1 : cellPx * 2 >= LABEL_PX ? 2 : 4;
  const others = p.views.filter((v) => !shows(v));

  return (
    <div
      className={p.compact ? 'ruler compact' : 'ruler'}
      onWheel={onWheel}
      onKeyDown={onKey}
      tabIndex={0}
      role="group"
      aria-label="Band ruler. Left and right arrows tune the selected view by 5 MHz (Shift: 20 MHz)"
    >
      <div className="rbands" role="group" aria-label="Channels shown">
        {(['2.4', '5', 'u12', 'u2e', 'u3'] as Range[]).map((b) => (
          <button key={b} className={b === band ? 'on' : ''} aria-pressed={b === band} onClick={() => showBand(b)} title={RANGES[b].title}>
            {RANGES[b].label}
          </button>
        ))}
      </div>
      <div className="rtrack" ref={track} onClick={(e) => !selLocked && p.onTune(at(e))} title={selLocked ? undefined : 'Click to tune the selected view here'}>
        {RANGES[band].groups
            .filter((g) => g.name)
            .map((g) => (
              <span key={g.name} className="rgroup" style={{ left: pc(pos(band, centre(g.chans[0]) - g.half)) }}>
                {g.name}
              </span>
            ))}
        {RANGES[band].groups.flatMap((g) =>
          g.chans.map((c) => {
            const db = p.survey.get(c);
            const a = pos(band, centre(c) - g.half), b = pos(band, centre(c) + g.half);
            // which channels are numbered when there is no room for all: 1, 6, 11 / every 2nd or 4th from 36
            const shown = band === '2.4' ? every === 1 || [1, 6, 11].includes(c) : ((c - (c > 144 ? 149 : 36)) / 4) % every === 0;
            return (
              <button
                key={c}
                className="rcell"
                tabIndex={-1}
                disabled={selLocked}
                style={{ left: pc(a), width: pc(b - a) }}
                aria-label={`Tune to channel ${c}`}
                title={`Channel ${c} · ${mhz(centre(c), 0)} MHz${db !== undefined ? ` · strongest seen: ${db.toFixed(0)} dB over the noise` : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onTune(centre(c));
                }}
              >
                <span>
                  {shown ? c : ''}
                  {cellPx >= FREQ_PX && <small>{mhz(centre(c), 0)}</small>}
                </span>
                {db !== undefined && <i className="rbar" style={bar(level(db))} />}
              </button>
            );
          }),
        )}
        {p.views
          .filter((v) => !others.includes(v))
          .map((v) => {
            const a = pos(band, v.lo), b = pos(band, v.hi);
            const inset = p.compact && v.slot === 1 && p.views.length > 1; // Compare: B inside A
            const name = SLOT_NAME[v.slot];
            const where = `View ${name}: ${mhz(v.lo, 0)}–${mhz(v.hi, 0)} MHz${v.gapped ? ' (gapped)' : ''}`;
            return (
              <span key={v.slot}>
                <span
                  className={`rview s${v.slot}${v.gapped ? ' gapped' : ''}${v.slot === p.sel ? ' sel' : ''}${inset ? ' inset' : ''}`}
                  style={{ left: pc(a), width: `max(6px, ${pc(b - a)})`, borderColor: VIEW_COLOUR[v.slot] }}
                  title={where}
                />
                <button
                  className={`rtab s${v.slot}${v.slot === p.sel ? ' sel' : ''}`}
                  // A's tab at its bracket's left end, B's at its right end: they never sit on each other
                  style={v.slot === 1 ? { right: pc(1 - b) } : { left: pc(a) }}
                  aria-label={`${where}. Edit view ${name}`}
                  aria-pressed={v.slot === p.sel}
                  title={`${where} · click to edit view ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onSelect(v.slot);
                  }}
                >
                  {name}
                </button>
              </span>
            );
          })}
      </div>
      {/* a view on the other band: a tab that shows that band */}
      {others.length > 0 && (
        <div className="rothers">
          {others.map((v) => (
            <button
              key={v.slot}
              className={`rtab s${v.slot}${v.slot === p.sel ? ' sel' : ''}`}
              title={`View ${SLOT_NAME[v.slot]} is at ${mhz((v.lo + v.hi) / 2, 0)} MHz: show those channels`}
              onClick={() => showBand(rangeOf((v.lo + v.hi) / 2))}
            >
              {SLOT_NAME[v.slot]} · {RANGES[rangeOf((v.lo + v.hi) / 2)].label} ▸
            </button>
          ))}
        </div>
      )}
      {!p.compact && (
        <div className="rfoot">
          {p.linkLabel && (
            <span className={p.otherBusy ? 'rlink paused' : 'rlink'}>
              {p.linkLabel}
              {p.otherBusy ? ` · ${p.otherBusy}` : ''}
            </span>
          )}
          <span className="spacer" />
          <span className="rkey" aria-hidden="true">
            quiet
            {[0, 0.5, 1].map((lv) => (
              <b key={lv}>
                <i className="rbar" style={bar(lv)} />
              </b>
            ))}
            strong
          </span>
          <span>strongest signal seen this session · wheel / arrow keys: 5 MHz</span>
        </div>
      )}
    </div>
  );
}
