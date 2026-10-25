// SPDX-License-Identifier: GPL-2.0-only
// Spectral Map: one adapter sweeps a range of channels, listening a while at each step; each sweep
// becomes a row of a heatmap (newest on top) on the band ruler's channel axis, so a column sits under
// its channel. Above it, the newest value of each MHz and the peak-hold over the sweeps kept. Each
// channel is heard only while the sweep is on it: the header says how long, and how often.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { RANGES, freqAt, planId, pos, sweepPlan, type Range } from './bands';
import { TURBO } from './colormap';
import type { Hub } from './hub';
import type { Device } from './protocol';
import { centre } from './survey';
import { mhz, type Prefs, type Scale } from './util';

const MAX_SWEEPS = 150;
const ROW_H = 6;   // CSS px per sweep in the heatmap
const AXIS_W = 46; // CSS px gutter on the left (dB axis, colour bar, ages), as the other plots
const TOP = 22;
const AXIS_H = 22;

type Sweep = { data: Float32Array; t: number }; // dBFS per MHz (NaN: not heard), when it ended
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = (n: number) => new Float32Array(n).fill(NaN);

export function SpectralMap(p: {
  hub: Hub; slot: number; range: Range; dev: Device | undefined; open: boolean; opening: boolean; running: boolean;
  dwell: number; gappedOk: boolean; prefs: Prefs; scale: Scale; setScale: (s: Scale) => void;
  onStart: () => void; onStop: () => void; onPick: (f: number) => void; onStep: (centre: number | null, fs: number) => void;
}) {
  const plan = sweepPlan(p.range, p.dev, p.gappedOk);
  const planKey = planId(plan);
  const spRef = useRef<HTMLCanvasElement>(null);
  const hmRef = useRef<HTMLCanvasElement>(null);
  // the sweep's data and the row callback's view of it (outside React state: rows arrive 25 times a second)
  const st = useRef({
    gen: -1, rowCentre: 0, collect: null as null | { c: number; into: Float32Array },
    sweeps: [] as Sweep[], partial: plan ? fresh(plan.n) : null, latest: plan ? fresh(plan.n) : null, step: -1,
  }); // (a new range or step plan mounts a new map: the shell keys it by the plan)
  const [info, setInfo] = useState({ sweeps: 0, last: 0 }); // sweeps done, the last one's seconds
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  // what the sweep and the drawing read (the sweep runs on across renders)
  const current = () => ({ scale: p.scale, prefs: p.prefs, setScale: p.setScale, range: p.range, plan, onStep: p.onStep });
  const opts = useRef(current());
  useEffect(() => {
    opts.current = current();
  });


  // rows of the sweeping adapter: the run byte (a retune starts a new run) and, while listening, the
  // values within the step
  useEffect(
    () =>
      p.hub.subscribe({
        slot: p.slot,
        row: (r) => {
          const s = st.current;
          s.gen = r.gen;
          s.rowCentre = r.f0 + r.df * (r.bins / 2 - 0.5);
          const col = s.collect, pl = opts.current.plan;
          if (!col || !pl || r.path !== 0) return;
          const src = opts.current.prefs.wfMode === 'avg' ? r.avg : r.max;
          for (let i = 0; i < r.bins; i++) {
            const f = r.f0 + i * r.df;
            if (Math.abs(f - col.c) > pl.step / 2 + 1e6) continue;
            const k = Math.floor((f - pl.lo) / 1e6);
            if (k < 0 || k >= pl.n) continue;
            const v = src[i];
            if (!(col.into[k] >= v)) col.into[k] = v;
            if (s.latest) s.latest[k] = col.into[k];
          }
        },
      }),
    [p.hub, p.slot],
  );

  // the sweep: retune, wait for the first row of the new run, listen, next; a row of the map per pass
  const active = p.running && p.open && !!plan;
  useEffect(() => {
    if (!active || !plan) return;
    let stop = false;
    const s = st.current;
    (async () => {
      while (!stop) {
        const into = fresh(plan.n);
        s.partial = into;
        const t0 = performance.now();
        for (let i = 0; i < plan.centres.length && !stop; i++) {
          const c = plan.centres[i];
          s.step = i;
          opts.current.onStep(c, plan.fs);
          const gen0 = s.gen;
          try {
            await p.hub.request('set', { slot: p.slot, freq: c, rate_sel: plan.rate_sel, wide: true });
          } catch {
            await sleep(500); // busy or closing: the next step, or the effect ends
            continue;
          }
          const w0 = performance.now();
          // the new run's first row (already there when the radio was on this step anyway)
          while (!stop && s.gen === gen0 && performance.now() - w0 < 3000 && !(performance.now() - w0 > 400 && Math.abs(s.rowCentre - c) < 2.5e6)) await sleep(10);
          s.collect = { c, into };
          await sleep(p.dwell);
          s.collect = null;
          draw();
        }
        if (stop) break;
        s.sweeps.unshift({ data: into, t: Date.now() });
        if (s.sweeps.length > MAX_SWEEPS) s.sweeps.pop();
        s.partial = fresh(plan.n);
        setInfo({ sweeps: s.sweeps.length, last: (performance.now() - t0) / 1000 });
        fit();
        draw();
      }
    })();
    return () => {
      stop = true;
      s.collect = null;
      s.step = -1;
      opts.current.onStep(null, 0);
    };
  }, [active, planKey, p.dwell]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto scale: from the noise of the newest sweep to over its peak-hold
  function fit() {
    if (opts.current.prefs.scale !== null) return;
    const s = st.current, newest = s.sweeps[0]?.data;
    if (!newest) return;
    const vals = Array.from(newest).filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length < 10) return;
    const floor = vals[Math.floor(vals.length * 0.2)], peak = vals[vals.length - 1];
    const dbMin = Math.floor((floor - 8) / 5) * 5, dbMax = Math.max(dbMin + 30, Math.ceil((peak + 5) / 5) * 5);
    opts.current.setScale({ dbMin, dbMax, wfFloor: Math.min(dbMax - 10, Math.round(floor + 3)) });
  }

  // Drawing: both canvases on the channel axis (x: 0..1 of the plot width)
  function draw() {
    const sp = spRef.current, hm = hmRef.current, s = st.current, { scale, range, plan: pl, prefs } = opts.current;
    if (!sp || !hm || !pl) return;
    const d = window.devicePixelRatio || 1;
    for (const c of [sp, hm]) {
      const w = Math.max(1, Math.round(c.clientWidth * d)), h = Math.max(1, Math.round(c.clientHeight * d));
      if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
    }
    const L = AXIS_W * d, w = sp.width - L;
    if (w <= 0) return;
    // the MHz bin under each pixel column (-1: a gap between channel groups)
    const col = new Int32Array(w);
    for (let x = 0; x < w; x++) {
      const f = freqAt(range, (x + 0.5) / w);
      const inGroup = RANGES[range].groups.some((g) => f >= centre(g.chans[0]) - g.half && f <= centre(g.chans[g.chans.length - 1]) + g.half);
      const k = Math.floor((f - pl.lo) / 1e6);
      col[x] = inGroup && k >= 0 && k < pl.n ? k : -1;
    }
    const lo = Math.min(scale.dbMax - 10, Math.max(scale.dbMin, scale.wfFloor)), hi = scale.dbMax;
    const colour = (v: number) => TURBO[Math.max(0, Math.min(255, Math.round(30 + ((v - lo) * 225) / Math.max(1, hi - lo))))];

    // spectrum: the newest value of each MHz, and the peak-hold over the sweeps kept
    const c = sp.getContext('2d')!, H = sp.height, T = TOP * d, ph = H - AXIS_H * d;
    c.fillStyle = '#0b0e13';
    c.fillRect(0, 0, sp.width, H);
    const yOf = (db: number) => T + (ph - T) * (1 - (db - scale.dbMin) / (scale.dbMax - scale.dbMin));
    c.font = `${11 * d}px system-ui, sans-serif`;
    c.textBaseline = 'middle';
    c.textAlign = 'right';
    const step = scale.dbMax - scale.dbMin > 60 ? 10 : 5;
    for (let db = Math.ceil(scale.dbMin / step) * step; db <= scale.dbMax; db += step) {
      const y = Math.round(yOf(db)) + 0.5;
      c.strokeStyle = '#1f2630';
      c.beginPath();
      c.moveTo(L, y);
      c.lineTo(sp.width, y);
      c.stroke();
      c.fillStyle = '#7d8896';
      c.fillText(String(db), L - 6 * d, y);
    }
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('dBFS', 4 * d, 3 * d);
    for (let x = 1; x < w; x++)
      if ((col[x] < 0) !== (col[x - 1] < 0) && col[x] < 0) {
        // a gap between channel groups
        let e = x;
        while (e < w && col[e] < 0) e++;
        c.fillStyle = '#141a22';
        c.fillRect(L + x, T, e - x, ph - T);
      }
    const hold = new Float32Array(pl.n).fill(NaN);
    for (const sw of [{ data: s.partial }, ...s.sweeps])
      if (sw.data) for (let k = 0; k < pl.n; k++) if (!(hold[k] >= sw.data[k])) hold[k] = sw.data[k];
    const line = (arr: Float32Array | null, colourOf: string, lw: number) => {
      if (!arr) return;
      c.strokeStyle = colourOf;
      c.lineWidth = lw * d;
      c.beginPath();
      let pen = false;
      for (let x = 0; x < w; x++) {
        const v = col[x] >= 0 ? arr[col[x]] : NaN;
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        const y = Math.max(T, Math.min(ph, yOf(v)));
        if (pen) c.lineTo(L + x, y);
        else c.moveTo(L + x, y);
        pen = true;
      }
      c.stroke();
    };
    if (prefs.showPeak) line(hold, '#8d99a8', 1);
    if (prefs.showAvg) line(s.latest, '#e6ebf1', 1.3);
    // MHz labels at the groups' first channels
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#7d8896';
    for (const g of RANGES[range].groups) for (const ch of g.chans.filter((_, i) => i % 2 === 0)) c.fillText(mhz(centre(ch), 0), L + pos(range, centre(ch)) * w, ph + (AXIS_H * d) / 2);
    // where the sweep is
    if (s.step >= 0) {
      const x = L + pos(range, pl.centres[s.step]) * w;
      c.strokeStyle = 'rgba(255,255,255,0.7)';
      c.setLineDash([3 * d, 3 * d]);
      c.beginPath();
      c.moveTo(x, T);
      c.lineTo(x, ph);
      c.stroke();
      c.setLineDash([]);
    }

    // heatmap: the sweep in progress on top, then the sweeps kept, newest first
    const m = hm.getContext('2d')!, rh = Math.max(1, Math.round(ROW_H * d));
    m.fillStyle = '#0b0e13';
    m.fillRect(0, 0, hm.width, hm.height);
    const rows = [s.partial, ...s.sweeps.map((x) => x.data)];
    const img = m.createImageData(w, 1);
    const px = new Uint32Array(img.data.buffer);
    for (let r = 0; r < rows.length && r * rh < hm.height; r++) {
      const arr = rows[r];
      if (!arr) continue;
      for (let x = 0; x < w; x++) {
        const k = col[x];
        px[x] = k < 0 ? 0xff221a14 : Number.isFinite(arr[k]) ? colour(arr[k]) : 0xff1b130e; // gap; not heard yet
      }
      for (let y = 0; y < rh - (rh > 2 ? 1 : 0); y++) m.putImageData(img, L, r * rh + y);
    }
    // the gutter: colour bar and the sweeps' ages
    m.fillStyle = '#0b0e13';
    m.fillRect(0, 0, L, hm.height);
    const barH = Math.min(hm.height - 20 * d, 160 * d);
    if (barH > 10) {
      const bar = m.createImageData(Math.round(6 * d), Math.round(barH));
      const bp = new Uint32Array(bar.data.buffer);
      for (let y = 0; y < bar.height; y++) for (let x = 0; x < bar.width; x++) bp[y * bar.width + x] = TURBO[Math.round(255 - (225 * y) / Math.max(1, bar.height - 1))];
      m.putImageData(bar, Math.round(4 * d), Math.round(6 * d));
    }
    m.fillStyle = '#7d8896';
    m.font = `${10 * d}px system-ui, sans-serif`;
    m.textAlign = 'left';
    m.textBaseline = 'top';
    m.fillText(String(Math.round(hi)), 13 * d, 6 * d);
    m.textBaseline = 'bottom';
    m.fillText(String(Math.round(lo)), 13 * d, 6 * d + barH - 10 * d);
    m.fillText('floor', 13 * d, 6 * d + barH);
    m.textAlign = 'right';
    m.textBaseline = 'middle';
    const now = Date.now();
    for (let r = 10; r < s.sweeps.length + 1 && r * rh < hm.height; r += 10) {
      const y = r * rh;
      if (y < 6 * d + barH + 14 * d) continue;
      m.fillRect(L - 5 * d, y, 4 * d, 1);
      m.fillText(`−${Math.round((now - s.sweeps[r - 1].t) / 1000)} s`, L - 7 * d, y);
    }
  }
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (spRef.current) ro.observe(spRef.current);
    if (hmRef.current) ro.observe(hmRef.current);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => draw()); // scale, range, toggles

  // hover: the channel, the value and how old it is; click: leave the map onto that channel
  const at = (e: MouseEvent<HTMLCanvasElement>, heat: boolean) => {
    const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left - AXIS_W;
    const w = r.width - AXIS_W, pl = plan;
    if (x < 0 || x > w || !pl) return null;
    const f = freqAt(p.range, x / w);
    const g = RANGES[p.range].groups.find((q) => f >= centre(q.chans[0]) - q.half && f <= centre(q.chans[q.chans.length - 1]) + q.half);
    if (!g) return null;
    const ch = g.chans.reduce((a, b) => (Math.abs(centre(b) - f) < Math.abs(centre(a) - f) ? b : a));
    const k = Math.floor((f - pl.lo) / 1e6), s = st.current;
    const row = heat ? Math.floor((e.clientY - r.top) / ROW_H) : -1;
    const arr = heat ? (row === 0 ? s.partial : s.sweeps[row - 1]?.data) : s.latest;
    const v = arr?.[k];
    const age = heat && row > 0 && s.sweeps[row - 1] ? ` · ${Math.round((Date.now() - s.sweeps[row - 1].t) / 1000)} s ago` : heat && row === 0 ? ' · this sweep' : '';
    return { ch, f, text: `ch ${ch} · ${mhz(f, 0)} MHz${Number.isFinite(v) ? ` · ${v!.toFixed(0)} dBFS` : ' · not heard'}${age} · click: open this channel` };
  };
  const onMove = (e: MouseEvent<HTMLCanvasElement>, heat: boolean) => {
    const a = at(e, heat);
    const box = e.currentTarget.parentElement!.getBoundingClientRect();
    setHover(a ? { x: e.clientX - box.left, y: e.clientY - box.top, text: a.text } : null);
  };
  const onClick = (e: MouseEvent<HTMLCanvasElement>, heat: boolean) => {
    const a = at(e, heat);
    if (a) p.onPick(centre(a.ch));
  };

  const perStep = p.dwell + 120;
  const sweepS = info.last || (plan ? (plan.centres.length * perStep) / 1000 : 0);
  return (
    <main className="smap" aria-label="Spectral map">
      <header className="vhead maphead">
        <span className="mtitle">Spectral Map</span>
        <span className="muted chlabel">
          {RANGES[p.range].title.replace(/^Channels [^:]*: /, '')} ·{' '}
          {plan ? `${plan.centres.length} steps of ${plan.fs / 1e6} MHz${plan.gapped ? ' (gapped)' : ''}` : 'no adapter'}
          {info.sweeps ? ` · last sweep ${info.last.toFixed(1)} s · ${info.sweeps} sweep${info.sweeps > 1 ? 's' : ''}` : ''}
        </span>
        {plan && (
          <span className="amber" title="A sweep visits one step at a time: what happens on a channel while the sweep is elsewhere is not seen">
            each step heard {p.dwell >= 1000 ? `${p.dwell / 1000} s` : `${p.dwell} ms`} per {sweepS.toFixed(1)} s sweep<span className="long">: bursts between visits are missed</span>
          </span>
        )}
        <span className="spacer" />
        <span className="state">
          <span className={active ? 'dot ok' : p.opening ? 'dot warn' : 'dot'} />
          <span className="stext">{active ? 'sweeping' : p.opening ? 'starting…' : 'stopped'}</span>
        </span>
        <button
          onClick={() => {
            const s = st.current;
            s.sweeps = [];
            s.partial = s.latest = plan ? fresh(plan.n) : null;
            setInfo({ sweeps: 0, last: 0 });
            draw();
          }}
          title="Start the map afresh"
        >
          Clear map
        </button>
        {p.running ? (
          <button onClick={p.onStop} title="Stop the sweep and the adapter">
            ■ Stop
          </button>
        ) : (
          <button disabled={!p.dev || !p.dev.can_open || p.opening} onClick={p.onStart} title="Start the adapter and sweep">
            ▶ Start
          </button>
        )}
        <button className="rec" disabled title="Recording needs a continuous span: a sweep jumps between frequencies">
          ● Rec
        </button>
      </header>
      <div className="smap-plots">
        <canvas ref={spRef} className="spectrum" onMouseMove={(e) => onMove(e, false)} onMouseLeave={() => setHover(null)} onClick={(e) => onClick(e, false)} />
        <canvas ref={hmRef} className="waterfall" onMouseMove={(e) => onMove(e, true)} onMouseLeave={() => setHover(null)} onClick={(e) => onClick(e, true)} />
        {hover && (
          <div className="smap-hover" style={{ left: Math.min(hover.x + 12, 9999), top: hover.y + 12 }}>
            {hover.text}
          </div>
        )}
        {!p.dev && <div className="vcard">No adapter for the map. Plug in an RTL8812BU or RTL8812CU.</div>}
        {p.dev && !p.running && !info.sweeps && (
          <div className="vcard">
            <h2>Map the {RANGES[p.range].label === '2.4 GHz' ? '2.4 GHz band' : `5 GHz ${p.range === '5' ? 'band' : `channels ${RANGES[p.range].label}`}`}</h2>
            <p>
              ▶ Start sweeps it with the {p.dev.model}. Each sweep adds a row, newest on top; a click on a channel opens it in the
              views.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
