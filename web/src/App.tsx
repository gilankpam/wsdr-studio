// SPDX-License-Identifier: GPL-2.0-only
// The window: top bar (mode), sidebar (the selected view's settings, the links, the display), and one
// view (Single) or two (Panorama: side by side in channel order; Compare: stacked, same channel).
// Two-view links: a linked setting changed in either view is applied to the other (the frequency
// keeps the views' distance).
import { useEffect, useRef, useState } from 'react';
import { Hub } from './hub';
import type { Device, RxSettings } from './protocol';
import { Station, type Link, type StationHandle, type ViewInfo } from './Station';
import { Tuner } from './Tuner';
import { NumField, Section } from './ui';
import {
  FFTS, SLOT_NAME, bandOf, baseName, bytes, loadPrefs, savePrefs, snap, spanLabel, type Locks, type Mode, type Prefs, type Scale,
} from './util';

const MODES: [Mode, string, string][] = [
  ['single', 'Single', 'One adapter'],
  ['panorama', 'Panorama', 'Two adapters, one picture: B continues where A ends'],
  ['compare', 'Compare', 'Two adapters on the same channel, one above the other'],
];

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const p = loadPrefs();
    if (new URLSearchParams(location.search).get('dual') === '1' && p.mode === 'single') {
      p.mode = 'panorama'; // started with --dual
      savePrefs(p);
    }
    return p;
  });
  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((old) => {
      const n = { ...old, ...p };
      savePrefs(n);
      return n;
    });
  const [scale, setScale] = useState<Scale>(() => loadPrefs().scale ?? { dbMin: -110, dbMax: -20, wfFloor: -100 });
  const [hub] = useState(() => new Hub());
  const [devices, setDevices] = useState<Device[]>([]);
  const [openKey, setOpenKey] = useState<(string | null)[]>([null, null]); // the adapter open in each slot
  const [views, setViews] = useState<(ViewInfo | null)[]>([null, null]);
  const [selSlot, setSelSlot] = useState(0);
  const [confirmSingle, setConfirmSingle] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1279px)').matches);
  const [drawer, setDrawer] = useState(false);
  const [sbEl, setSbEl] = useState<HTMLDivElement | null>(null);
  const handles = useRef<(StationHandle | null)[]>([null, null]);
  const { mode, locks } = prefs;
  const dual = mode !== 'single';
  const sel = dual ? selSlot : 0;
  const now = useRef({ mode, locks });

  useEffect(() => {
    hub.start();
    const unsubscribe = hub.subscribe({
      slot: null,
      event: (e) => {
        if (e.type === 'devices') setDevices(e.devices);
        else if (e.type === 'caps' && e.slot !== undefined)
          setOpenKey((k) => k.map((x, i) => (i === e.slot ? (e.open && e.bus >= 0 ? `${e.bus}-${e.port}` : null) : x)));
        else if (e.type === 'recorded' && e.slot === 1 && now.current.mode === 'single')
          // view B ended after leaving the two-view modes: its note goes to view A
          handles.current[0]?.notice(`View B's recording saved: ${baseName(e.file)} · ${bytes(e.bytes)}`);
      },
    });
    return () => {
      unsubscribe();
      hub.stop();
    };
  }, [hub]);
  useEffect(() => {
    const mq = matchMedia('(max-width: 1279px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const sidebarShown = narrow ? drawer : prefs.sidebar;
  const toggleSidebar = () => (narrow ? setDrawer((v) => !v) : updatePrefs({ sidebar: !prefs.sidebar }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The other view takes the linked fields of a change: the frequency at the same distance (snapped to
  // the tuning grid, in its band), a span only when its adapter shows it continuously, gain and AGC.
  const forward = (slot: number, args: Partial<RxSettings>, use: Locks) => {
    const other = handles.current[slot ^ 1], me = handles.current[slot];
    if (now.current.mode === 'single' || !other || !me) return;
    const name = SLOT_NAME[slot ^ 1];
    const a: Partial<RxSettings> = {};
    if (use.freq && args.freq !== undefined) {
      const want = args.freq + (other.freq() - me.freq());
      const f = snap(want);
      if (Math.abs(f - want) > 2.5e6 || bandOf(want) !== bandOf(other.freq()))
        me.notice(`View ${name} cannot follow: ${(want / 1e6).toFixed(0)} MHz is outside its band`);
      else a.freq = f;
    }
    if (use.span && args.rate_sel !== undefined) {
      if (other.rateOk(args.rate_sel)) {
        a.rate_sel = args.rate_sel;
        a.wide = args.wide ?? true;
      } else me.notice(`View ${name} keeps its span: its adapter cannot show ${spanLabel(80e6 / (1 << args.rate_sel))} continuously`);
    }
    if (use.gain && args.gain_db !== undefined) a.gain_db = args.gain_db;
    if (use.gain && args.agc !== undefined) a.agc = args.agc;
    if (!Object.keys(a).length) return;
    const why = other.busy();
    if (why) me.notice(`View ${name} did not follow: ${why}`); // a recording must not be ended by a link
    else other.linkedSet(a);
  };
  const fwd = useRef(forward);
  // One scale for both views, fitted to both pictures.
  const fit = (wfMode?: 'max' | 'avg') => {
    const s = handles.current
      .filter((_, i) => i === 0 || now.current.mode !== 'single')
      .map((h) => h?.suggest(wfMode) ?? null)
      .filter((x): x is Scale => x !== null);
    if (s.length)
      setScale({ dbMin: Math.min(...s.map((x) => x.dbMin)), dbMax: Math.max(...s.map((x) => x.dbMax)), wfFloor: Math.min(...s.map((x) => x.wfFloor)) });
  };
  const autoFit = useRef(fit);
  // The views call these from callbacks made at mount: they read the current state through refs.
  const [link] = useState<Link>(() => ({
    register: (slot, h) => {
      handles.current[slot] = h;
    },
    report: (slot, v) => setViews((old) => old.map((x, i) => (i === slot ? v : x))),
    userSet: (slot, args) => fwd.current(slot, args, now.current.locks),
    autoFit: () => autoFit.current(),
  }));
  // the latest state and functions for those callbacks, after every render
  useEffect(() => {
    now.current = { mode, locks };
    fwd.current = forward;
    autoFit.current = fit;
  });

  const setLock = (k: keyof Locks) => {
    const on = !locks[k];
    setPrefs((old) => {
      const n = { ...old, locks: { ...old.locks, [k]: on } };
      savePrefs(n);
      return n;
    });
    // engaging a span or gain link aligns the other view to the selected one now
    const v = views[sel];
    if (on && v && k !== 'freq')
      forward(sel, k === 'span' ? { rate_sel: v.rate_sel, wide: true } : { gain_db: v.gain_db, agc: v.agc }, { freq: false, span: k === 'span', gain: k === 'gain' });
  };
  // Entering Panorama puts B one span above A; Compare puts it on A's frequency.
  const prevMode = useRef(mode);
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = mode;
    if (was === mode || mode === 'single') return;
    const a = handles.current[0], b = handles.current[1], va = views[0];
    if (!a || !b || !va) return;
    const why = b.busy();
    if (why) {
      a.notice(`View B did not move: ${why}`);
      return;
    }
    const want = va.freq + (mode === 'panorama' ? va.fsNow : 0);
    const args: Partial<RxSettings> = {};
    if (Math.abs(snap(want) - want) <= 2.5e6 && bandOf(want) === bandOf(va.freq)) args.freq = snap(want);
    else a.notice(`View B stays: ${(want / 1e6).toFixed(0)} MHz is outside the band`);
    if (b.rateOk(va.rate_sel)) {
      args.rate_sel = va.rate_sel;
      args.wide = true;
    }
    b.linkedSet(args);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const setMode = (m: Mode) => {
    setConfirmSingle(false);
    if (m === 'single' && dual && (views[1]?.open || openKey[1])) {
      setConfirmSingle(true); // view B is running: ask first
      return;
    }
    updatePrefs({ mode: m });
  };
  const stopBAndSingle = () => {
    setConfirmSingle(false);
    hub.request('close', { slot: 1 }).catch(() => {});
    updatePrefs({ mode: 'single' });
  };
  const setUserScale = (sc: Scale) => {
    const dbMin = Math.min(sc.dbMin, sc.dbMax - 10);
    const n = { dbMin, dbMax: Math.max(sc.dbMax, dbMin + 10), wfFloor: sc.wfFloor };
    setScale(n);
    updatePrefs({ scale: n }); // a scale the user chose survives restarts (no automatic refit)
  };

  const vs = views[sel];
  const fsNow = vs?.fsNow ?? 5e6;
  const gapped = vs?.gapped ?? false;
  const fft = vs?.fft ?? prefs.fft;
  const dist = views[0] && views[1] ? Math.round((views[1].freq - views[0].freq) / 1e6) : null;
  const distLabel = dist === null ? '' : dist === 0 ? ' · B = A' : dist > 0 ? ` · B = A + ${dist}` : ` · B = A − ${-dist}`;
  const anyLock = locks.freq || locks.span || locks.gain;
  const linksBox = dual && (
    <div className="links">
      <span className="note">{anyLock ? 'Moving either view moves both' : 'The views move independently'}</span>
      <div className="chips">
        <button
          className={locks.freq ? 'chip on' : 'chip'}
          aria-pressed={locks.freq}
          onClick={() => setLock('freq')}
          title="Linked: retuning either view retunes the other by the same amount, keeping their distance"
        >
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
          </svg>
          Frequency{distLabel}
        </button>
        <button className={locks.span ? 'chip on' : 'chip'} aria-pressed={locks.span} onClick={() => setLock('span')} title="Linked: both views show the same span (where both adapters show it continuously)">
          Span
        </button>
        <button className={locks.gain ? 'chip on' : 'chip'} aria-pressed={locks.gain} onClick={() => setLock('gain')} title="Linked: gain and AGC change together (two dongles' gains differ slightly)">
          Gain
        </button>
      </div>
    </div>
  );
  const auto = prefs.scale === null;

  return (
    <div className={`app mode-${mode}`}>
      <header className="topbar">
        <button className="icon" aria-label={sidebarShown ? 'Hide the sidebar (Ctrl+B)' : 'Show the sidebar (Ctrl+B)'} title="Sidebar (Ctrl+B)" onClick={toggleSidebar}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <span className="brand">wsdr-studio</span>
        <div className="seg modes" role="group" aria-label="Mode">
          {MODES.map(([m, label, hint]) => {
            const off = m !== 'single' && m !== mode && devices.length < 2;
            return (
              <button key={m} className={m === mode ? 'on' : ''} aria-pressed={m === mode} disabled={off} title={off ? 'Needs a second adapter' : hint} onClick={() => setMode(m)}>
                {label}
              </button>
            );
          })}
        </div>
        <span className="hint">{MODES.find((x) => x[0] === mode)![2]}</span>
        {confirmSingle && (
          <div className="confirm" role="alertdialog" aria-label="Leave the two-view mode">
            View B is {views[1]?.recording ? 'recording' : 'running'}. Single stops it{views[1]?.recording ? ' and saves the recording' : ''}.
            <button onClick={stopBAndSingle}>Stop B</button>
            <button onClick={() => setConfirmSingle(false)}>Cancel</button>
          </div>
        )}
      </header>
      <div className="body">
        {sidebarShown && (
          <>
            {narrow && <div className="backdrop" onClick={() => setDrawer(false)} />}
            <aside className={narrow ? 'sidebar drawer' : 'sidebar'}>
              {dual && (
                <div className="editing">
                  <span>Editing</span>
                  <div className="seg wide" role="group" aria-label="Editing view">
                    {[0, 1].map((i) => (
                      <button key={i} className={`s${i}${sel === i ? ' on' : ''}`} aria-pressed={sel === i} onClick={() => setSelSlot(i)}>
                        {SLOT_NAME[i]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="sbviews" ref={setSbEl} />
              <Section
                id="display"
                title="Display"
                prefs={prefs}
                updatePrefs={updatePrefs}
                summary={`${scale.dbMin} … ${scale.dbMax} dBFS · ${auto ? 'Auto' : 'fixed'} · FFT ${fft}`}
              >
                <div className="row" title={dual ? 'Shared by both views' : undefined}>
                  <NumField label="Scale bottom, dBFS" value={scale.dbMin} title="Bottom of the scale (dBFS); Enter to apply" onCommit={(v) => setUserScale({ ...scale, dbMin: v })} />
                  <span className="muted">to</span>
                  <NumField label="Scale top, dBFS" value={scale.dbMax} title="Top of the scale (dBFS); Enter to apply" onCommit={(v) => setUserScale({ ...scale, dbMax: v })} />
                  <span className="muted">dBFS</span>
                  <button
                    className={auto ? 'on' : ''}
                    aria-pressed={auto}
                    title={
                      auto
                        ? 'Auto scale is on: refits after Start, retune, span, gain or FFT change. Type a value to fix the scale.'
                        : 'Fit the scale to the signal now, and keep refitting after Start, retune, span, gain or FFT changes'
                    }
                    onClick={() => {
                      fit();
                      updatePrefs({ scale: null });
                    }}
                  >
                    Auto
                  </button>
                </div>
                <label className="field inline">
                  FFT size
                  <select value={fft} onChange={(e) => updatePrefs({ fft: Number(e.target.value) })}>
                    {FFTS.map((n) => (
                      <option key={n} value={n} disabled={gapped && n > 8192}>
                        {n <= 4096 ? `${n} · ${(fsNow / n / 1e3).toFixed(1)} kHz/bin` : `${n} · ${(fsNow / 4096 / 1e3).toFixed(1)} kHz/bin, smoother noise`}
                        {gapped && n > 8192 ? ' (not in gapped mode)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field inline">
                  Averaging
                  <select value={prefs.smooth} onChange={(e) => updatePrefs({ smooth: Number(e.target.value) })}>
                    <option value={0}>off</option>
                    <option value={0.5}>low</option>
                    <option value={0.7}>medium</option>
                    <option value={0.9}>high</option>
                  </select>
                </label>
                <label className="field inline">
                  Waterfall
                  <select
                    value={prefs.wfMode}
                    onChange={(e) => {
                      const m = e.target.value as 'max' | 'avg';
                      updatePrefs({ wfMode: m });
                      if (auto) fit(m); // the floor depends on the mode
                    }}
                  >
                    <option value="max">peak (shows short frames)</option>
                    <option value="avg">average</option>
                  </select>
                </label>
                <label className="field inline">
                  Waterfall floor
                  <span className="row">
                    <NumField label="Waterfall floor, dBFS" value={scale.wfFloor} title="Colour of the waterfall starts here (dBFS)" onCommit={(v) => setUserScale({ ...scale, wfFloor: v })} />
                    <span className="muted">dBFS</span>
                  </span>
                </label>
              </Section>
            </aside>
          </>
        )}
        <main className="workspace">
          <Tuner freq={vs?.freq ?? 5180e6} disabled={vs?.locked ?? true} onTune={(f) => handles.current[sel]?.tune(f)} />
          <div className={`views ${mode}`}>
            {[0, 1]
              .filter((i) => i === 0 || dual)
              .map((i) => (
                <Station
                  key={i}
                  slot={i}
                  mode={mode}
                  hub={hub}
                  shared={{ prefs, updatePrefs, scale, setScale }}
                  link={link}
                  selected={sel === i}
                  onSelect={() => setSelSlot(i)}
                  sidebar={sbEl}
                  linksBox={linksBox}
                  otherSel={dual ? views[i ^ 1]?.selKey ?? null : null}
                  otherOpen={openKey[i ^ 1]}
                />
              ))}
          </div>
        </main>
      </div>
    </div>
  );
}
