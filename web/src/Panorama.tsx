// SPDX-License-Identifier: GPL-2.0-only
// Panorama: one spectrum and one waterfall across both views' spans (A's part, then B's), each part in
// its view's colour, the seam marked. The views' own plots are hidden meanwhile (they still fit Auto).
import { useEffect, useRef, useState } from 'react';
import { Display, type Source } from './display';
import type { Hub } from './hub';
import type { Prefs, Scale } from './util';

export function Panorama(p: {
  hub: Hub; prefs: Prefs; updatePrefs: (p: Partial<Prefs>) => void; scale: Scale; sources: (Source | null)[]; overlay: string | null;
  onRetune: (f: number) => void;
  offAxis: string | null; // a stopped view left off the axis (far away): where it is
}) {
  const spRef = useRef<HTMLCanvasElement>(null);
  const wfRef = useRef<HTMLCanvasElement>(null);
  const display = useRef<Display | null>(null);
  const retune = useRef(p.onRetune);
  const [hint, setHint] = useState<string | null>(null);
  const stitch = p.sources.map(
    (x) => x ?? { lo: 0, hi: 0, colour: '', pathColours: null, marker: null, markerLabel: '', chipNotch: false, notchWide: false, dim: true, msg: null },
  );
  const opts = {
    ...p.scale, wfMode: p.prefs.wfMode, smooth: p.prefs.smooth, showAvg: p.prefs.showAvg, showPeak: p.prefs.showPeak,
    overlay: p.overlay, stitch, staleText: 'No data from the adapters',
  };
  const optsRef = useRef(opts);
  const key = JSON.stringify(opts); // set when something changed, not on every render of the window
  useEffect(() => {
    optsRef.current = opts;
    display.current?.setOpts(opts);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    retune.current = p.onRetune;
  });
  useEffect(() => {
    const d = new Display(spRef.current!, wfRef.current!);
    display.current = d;
    d.setOpts(optsRef.current); // stitched before the first row
    const ro = new ResizeObserver(() => d.resize());
    ro.observe(spRef.current!);
    ro.observe(wfRef.current!);
    d.resize();
    d.onRetune = (f) => retune.current(f);
    let timer = 0;
    d.onHint = (t) => {
      setHint(t);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHint(null), 5000);
    };
    const unsubscribe = p.hub.subscribe({ slot: null, all: (r) => d.push(r) });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
      ro.disconnect();
      d.destroy();
    };
  }, [p.hub]);
  return (
    <main className="plots pano" aria-label="Panorama: views A and B on one axis">
      {/* one legend for the stitched plot (the traces are both views', in their colours) */}
      <div className="legend pano-legend">
        {(
          [
            ['average', p.prefs.showAvg, () => p.updatePrefs({ showAvg: !p.prefs.showAvg })],
            ['peak', p.prefs.showPeak, () => p.updatePrefs({ showPeak: !p.prefs.showPeak })],
          ] as [string, boolean, () => void][]
        ).map(([label, on, fn]) => (
          <button key={label} className={on ? 'on' : 'off'} aria-pressed={on} onClick={fn} title={`${on ? 'Hide' : 'Show'} the ${label} traces`}>
            <span className="swatch" style={{ background: label === 'peak' ? '#8d99a8' : 'linear-gradient(90deg, #4fc3f7 50%, #c792ea 50%)' }} />
            {label}
          </button>
        ))}
      </div>
      {p.offAxis && <div className="offaxis">{p.offAxis}</div>}
      <div className="toasts">
        {hint && (
          <div className="toast" onClick={() => setHint(null)}>
            {hint}
          </div>
        )}
      </div>
      <canvas ref={spRef} className="spectrum" />
      <canvas ref={wfRef} className="waterfall" />
    </main>
  );
}
