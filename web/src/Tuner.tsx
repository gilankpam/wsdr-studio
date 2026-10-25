// SPDX-License-Identifier: GPL-2.0-only
// Centre-frequency slider: the radio tunes in 5 MHz steps, one notch each (drag, or arrow keys). The
// 2.4 and 5 GHz bands are separate ranges, picked with the band buttons. The value is sent 200 ms
// after the last move, so a drag does not restart the stream at every notch.
import { useRef, useState } from 'react';
import { CHANNELS } from './channels';

const BANDS = { '2.4': { lo: 2412e6, hi: 2472e6, home: 2437e6 }, '5': { lo: 5080e6, hi: 6165e6, home: 5180e6 } } as const;
type Band = keyof typeof BANDS;

export function Tuner({ freq, disabled, onTune }: { freq: number; disabled: boolean; onTune: (f: number) => void }) {
  const band: Band = freq < 3.7e9 ? '2.4' : '5';
  const b = BANDS[band];
  const [drag, setDrag] = useState<number | null>(null); // moved, not sent yet
  const [sent, setSent] = useState<number | null>(null); // sent, settings not back yet
  const timer = useRef<number | undefined>(undefined);
  const clamp = (f: number) => Math.min(b.hi, Math.max(b.lo, Math.round(f / 5e6) * 5e6));
  const shown = drag ?? (sent !== null && Math.abs(freq - sent) >= 1 ? sent : clamp(freq));
  const pct = (f: number) => ((f - b.lo) / (b.hi - b.lo)) * 100;
  const move = (f: number) => {
    setDrag(f);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setDrag(null);
      setSent(f);
      onTune(f);
      window.setTimeout(() => setSent(null), 1500); // a refused or clamped tune shows the truth again
    }, 200);
  };
  const ticks = CHANNELS.filter((c) => c.band === band && c.width === 20 && c.centre >= b.lo && c.centre <= b.hi);
  return (
    <div className="tuner">
      <div className="bands">
        {(Object.keys(BANDS) as Band[]).map((k) => (
          <button key={k} className={k === band ? 'on' : ''} disabled={disabled} onClick={() => k !== band && onTune(BANDS[k].home)}>
            {k} GHz
          </button>
        ))}
      </div>
      <div className="track">
        <input
          type="range"
          min={b.lo}
          max={b.hi}
          step={5e6}
          value={shown}
          disabled={disabled}
          onChange={(e) => move(Number(e.target.value))}
          aria-label="Centre frequency"
          title="Centre frequency: drag, or use the arrow keys (5 MHz per step)"
        />
        <div className="ticks">
          {ticks.map((c) => (
            <span key={c.ch} style={{ left: `${pct(c.centre)}%` }}>
              {c.label}
            </span>
          ))}
        </div>
      </div>
      <span className="val">{(shown / 1e6).toFixed(0)} MHz</span>
    </div>
  );
}
