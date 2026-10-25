// SPDX-License-Identifier: GPL-2.0-only
// Panorama: one spectrum and one waterfall across both views' spans (A's part, then B's), each part in
// its view's colour, the seam marked. The views' own plots are hidden meanwhile (they still fit Auto).
import { useEffect, useRef, useState } from 'react';
import { Display, type Source } from './display';
import type { Hub } from './hub';
import type { Prefs, Scale } from './util';

export function Panorama(p: {
  hub: Hub; prefs: Prefs; scale: Scale; sources: (Source | null)[]; overlay: string | null; onRetune: (f: number) => void;
}) {
  const spRef = useRef<HTMLCanvasElement>(null);
  const wfRef = useRef<HTMLCanvasElement>(null);
  const display = useRef<Display | null>(null);
  const retune = useRef(p.onRetune);
  const [hint, setHint] = useState<string | null>(null);
  const stitch = p.sources.map((x) => x ?? { lo: 0, hi: 0, colour: '', marker: null, markerLabel: '', chipNotch: false, notchWide: false, dim: true, msg: null });
  const opts = {
    ...p.scale, wfMode: p.prefs.wfMode, smooth: p.prefs.smooth, showAvg: p.prefs.showAvg, showPeak: p.prefs.showPeak,
    overlay: p.overlay, stitch, staleText: 'No data from the adapters',
  };
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
    retune.current = p.onRetune;
    display.current?.setOpts(opts);
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
