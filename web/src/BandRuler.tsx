// SPDX-License-Identifier: GPL-2.0-only
// The band ruler: 2.4 GHz (compressed) and 5 GHz side by side, a cell per channel (click: tune the
// selected view there), a bracket per view at the span it shows (its tab selects the view), and a
// survey tint: the strongest signal seen on each channel this session, in dB above the noise.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { GROUPS, HIGH, LOW, centre, tint, type Seg, type Survey } from './survey';
import { SLOT_NAME, VIEW_COLOUR, mhz } from './util';

const pct = (s: Seg, f: number) => `${(((f - s.lo) / (s.hi - s.lo)) * 100).toFixed(3)}%`;
const between = (s: Seg, a: number, b: number) => ({ left: pct(s, a), width: `calc(${pct(s, b)} - ${pct(s, a)})` });
const WHEEL_PX = 50; // wheel distance per 5 MHz step (a notch is ~50-120 px; trackpads send many small ones)
const WHEEL_MAX = 4; // steps per burst at most

export type RulerView = { slot: number; lo: number; hi: number; locked: boolean; gapped: boolean };

export function BandRuler(p: {
  views: RulerView[]; sel: number; compact: boolean; survey: Survey; linkLabel: string | null; otherBusy: string | null;
  onTune: (f: number) => void; onStep: (steps: number) => void; onSelect: (slot: number) => void;
}) {
  const wheel = useRef({ px: 0, t: 0 });
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
  const selLocked = p.views.find((v) => v.slot === p.sel)?.locked ?? true;
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
  const segOf = (v: RulerView) => (v.lo < 3.7e9 ? LOW : HIGH);
  const segment = (s: Seg, name: string) => {
    const at = (e: MouseEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      return s.lo + ((e.clientX - r.left) / r.width) * (s.hi - s.lo);
    };
    return (
      <div className={`rseg ${name}`} onClick={(e) => !selLocked && p.onTune(at(e))} title={selLocked ? undefined : 'Click to tune the selected view here'}>
        {!p.compact && name === 'low' && <span className="rband">2.4 GHz</span>}
        {!p.compact &&
          name === 'high' &&
          GROUPS.map(([g, a, b]) => (
            <span key={g} className="rgroup" style={between(s, a, b)}>
              {g}
            </span>
          ))}
        {s.chans.map((c, i) => {
          const db = p.survey.get(c);
          return (
            <button
              key={c}
              className="rcell"
              tabIndex={-1}
              disabled={selLocked}
              style={{ ...between(s, centre(c) - s.half, centre(c) + s.half), background: tint(db) }}
              aria-label={`Tune to channel ${c}`}
              title={`Channel ${c} · ${mhz(centre(c), 0)} MHz${db !== undefined ? ` · strongest seen: ${db.toFixed(0)} dB over the noise` : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onTune(centre(c));
              }}
            >
              <span>{s.label(c, i)}</span>
            </button>
          );
        })}
        {p.views
          .filter((v) => segOf(v) === s)
          .map((v) => {
            // a view beyond the drawn segment (5080-5150, 5895-6165 MHz) sits at its edge
            const out = v.hi <= s.lo ? 'left' : v.lo >= s.hi ? 'right' : null;
            const lo = out === 'right' ? s.hi : Math.max(s.lo, v.lo);
            const hi = out === 'left' ? s.lo : Math.min(s.hi, v.hi);
            const inset = p.compact && v.slot === 1 && p.views.length > 1; // Compare: B inside A
            const name = SLOT_NAME[v.slot];
            const where = `View ${name}: ${mhz(v.lo, 0)}–${mhz(v.hi, 0)} MHz${v.gapped ? ' (gapped)' : ''}`;
            return (
              <span key={v.slot}>
                <span
                  className={`rview s${v.slot}${v.gapped ? ' gapped' : ''}${v.slot === p.sel ? ' sel' : ''}${inset ? ' inset' : ''}${out ? ' out' : ''}`}
                  style={{ ...between(s, lo, hi), borderColor: VIEW_COLOUR[v.slot] }}
                  title={where}
                />
                {!p.compact && (
                  <button
                    className={`rtab s${v.slot}${v.slot === p.sel ? ' sel' : ''}${out === 'right' ? ' end' : ''}`}
                    style={out === 'right' ? { right: 0 } : { left: pct(s, lo) }}
                    aria-label={`${where}. Edit view ${name}`}
                    aria-pressed={v.slot === p.sel}
                    title={`${where} · click to edit view ${name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onSelect(v.slot);
                    }}
                  >
                    {out === 'left' ? `◂ ${name} ${mhz((v.lo + v.hi) / 2, 0)}` : out === 'right' ? `${name} ${mhz((v.lo + v.hi) / 2, 0)} ▸` : name}
                  </button>
                )}
              </span>
            );
          })}
      </div>
    );
  };
  return (
    <div
      className={p.compact ? 'ruler compact' : 'ruler'}
      onWheel={onWheel}
      onKeyDown={onKey}
      tabIndex={0}
      role="group"
      aria-label="Band ruler. Left and right arrows tune the selected view by 5 MHz (Shift: 20 MHz)"
    >
      {segment(LOW, 'low')}
      <span className="rbreak" aria-hidden="true">
        ┃
      </span>
      {segment(HIGH, 'high')}
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
            <i style={{ background: tint(3) }} />
            <i style={{ background: tint(16) }} />
            <i style={{ background: tint(30) }} />
            strong
          </span>
          <span>strongest signal seen this session · wheel or ← →: 5 MHz</span>
        </div>
      )}
    </div>
  );
}
