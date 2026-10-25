// SPDX-License-Identifier: GPL-2.0-only
// The band ruler: 2.4 GHz (compressed) and 5 GHz side by side, a cell per channel (click: tune the
// selected view there), a bracket per view at the span it shows, and a survey tint: the strongest
// signal seen on each channel this session, in dB above the noise floor.
import { useRef, type MouseEvent, type WheelEvent } from 'react';
import { GROUPS, HIGH, LOW, centre, type Seg, type Survey } from './survey';
import { SLOT_NAME, VIEW_COLOUR, mhz } from './util';

const pct = (s: Seg, f: number) => `${(((f - s.lo) / (s.hi - s.lo)) * 100).toFixed(3)}%`;

export type RulerView = { slot: number; lo: number; hi: number; locked: boolean; gapped: boolean; recording: boolean };

export function BandRuler(p: {
  views: RulerView[]; sel: number; compact: boolean; survey: Survey; linkLabel: string | null; otherBusy: string | null;
  onTune: (f: number) => void; onStep: (steps: number) => void; onSelect: (slot: number) => void;
}) {
  const wheel = useRef({ n: 0, t: 0 });
  const selLocked = p.views.find((v) => v.slot === p.sel)?.locked ?? true;
  const tint = (c: number) => {
    const db = p.survey.get(c);
    if (db === undefined) return undefined;
    const o = Math.min(1, Math.max(0, (db - 6) / 30)); // ~6 dB over the floor is noise-only peaks
    return `rgba(240, 160, 62, ${(0.1 + 0.55 * o).toFixed(2)})`;
  };
  const onWheel = (e: WheelEvent) => {
    if (selLocked || !e.deltaY) return;
    const w = wheel.current;
    w.n += e.deltaY > 0 ? -1 : 1; // down: lower
    window.clearTimeout(w.t);
    w.t = window.setTimeout(() => {
      p.onStep(w.n); // one retune for a burst of wheel steps
      w.n = 0;
    }, 150);
  };
  const segment = (s: Seg, name: string) => {
    const at = (e: MouseEvent<HTMLDivElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      return s.lo + ((e.clientX - r.left) / r.width) * (s.hi - s.lo);
    };
    return (
      <div className={`rseg ${name}`} onClick={(e) => !selLocked && p.onTune(at(e))} title={selLocked ? undefined : 'Click to tune the selected view here'}>
        {!p.compact && <span className="rband">{name === 'low' ? '2.4 GHz' : ''}</span>}
        {!p.compact &&
          name === 'high' &&
          GROUPS.map(([g, a, b]) => (
            <span key={g} className="rgroup" style={{ left: pct(s, a), width: `calc(${pct(s, b)} - ${pct(s, a)})` }}>
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
              style={{ left: pct(s, centre(c) - s.half), width: `calc(${pct(s, centre(c) + s.half)} - ${pct(s, centre(c) - s.half)})`, background: tint(c) }}
              aria-label={`Tune to channel ${c}`}
              title={`Channel ${c} · ${mhz(centre(c), 0)} MHz${db !== undefined ? ` · strongest seen: ${db.toFixed(0)} dB over the noise` : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onTune(centre(c));
              }}
            >
              {p.compact ? '' : s.label(c, i)}
            </button>
          );
        })}
        {p.views
          .filter((v) => v.hi > s.lo && v.lo < s.hi)
          .map((v) => (
            <button
              key={v.slot}
              className={`rview s${v.slot}${v.gapped ? ' gapped' : ''}${v.slot === p.sel ? ' sel' : ''}`}
              style={{ left: pct(s, Math.max(s.lo, v.lo)), width: `calc(${pct(s, Math.min(s.hi, v.hi))} - ${pct(s, Math.max(s.lo, v.lo))})`, borderColor: VIEW_COLOUR[v.slot] }}
              aria-label={`View ${SLOT_NAME[v.slot]}: ${mhz(v.lo, 0)}–${mhz(v.hi, 0)} MHz`}
              title={`View ${SLOT_NAME[v.slot]}: ${mhz(v.lo, 0)}–${mhz(v.hi, 0)} MHz${v.gapped ? ' (gapped)' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                p.onSelect(v.slot);
              }}
            >
              {p.views.length > 1 && !p.compact ? SLOT_NAME[v.slot] : ''}
            </button>
          ))}
      </div>
    );
  };
  return (
    <div className={p.compact ? 'ruler compact' : 'ruler'} onWheel={onWheel} role="group" aria-label="Band ruler">
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
          <span>cells: strongest signal seen this session · wheel: 5 MHz steps</span>
        </div>
      )}
    </div>
  );
}
