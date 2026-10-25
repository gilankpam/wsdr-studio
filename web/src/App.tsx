// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState } from 'react';
import { CHANNELS, channelAt, channelKey, type Channel } from './channels';
import { Display } from './display';
import { Client, type Caps, type Device, type DspSettings, type Rate, type RxSettings, type Status } from './protocol';

const FFTS = [1024, 2048, 4096, 8192, 16384];
const RATES: Rate[] = [5, 4, 3, 2, 1].map((r) => ({ rate_sel: r, fs: 80e6 / (1 << r) }));
// What an adapter offers before Start (after Start the backend's caps say it).
const ratesFor = (d?: Device): Rate[] =>
  d
    ? RATES.filter((r) => r.fs <= d.max_msps * 1e6 || r.fs <= (d.gapped_msps ?? 0) * 1e6).map((r) => ({ ...r, gapped: r.fs > d.max_msps * 1e6 }))
    : RATES;
// Share of the time a gapped span samples: one 8192-sample bank, then ~1.48 ms shipping it over USB 2.
const gappedDuty = (fs: number) => 8192 / fs / (8192 / fs + 1.48e-3);
const mhz = (hz: number, d = 1) => (hz / 1e6).toFixed(d);
const spanLabel = (fs: number) => `${fs / 1e6} MHz`;
const devKey = (d: Device) => `${d.bus}-${d.port}`;
const devLabel = (d: Device) => `${d.model} · ${d.speed_mbps >= 5000 ? 'USB 3' : 'USB 2'}`;
const devTitle = (d: Device) =>
  `${d.model} (${d.chip}), bus ${d.bus} port ${d.port}, ${d.speed_mbps} Mbit/s${d.controller ? `, host controller ${d.controller}` : ''}`;
const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`);
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const chanName = (c: Channel) => (c.width === 40 ? `ch ${c.ch + 2} (${c.label})` : `ch ${c.label}`);
const fmtDur = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${Math.floor(s / 60)} min` : `${Math.max(0, Math.floor(s))} s`);
// The radio tunes in 5 MHz steps (2.4 GHz: 2407 + 5n MHz; 5 GHz: 5000 + 5n MHz).
// The radio tunes 2.4 GHz channels 1-13 (2412-2472, 5 MHz apart) and 14 (2484), and 5 GHz in 5 MHz
// steps from 5080 to 6165 MHz. The nearest tunable centre:
// (At 40 MHz width the centres run 2422-2462 and 5090-6155 MHz.)
const snap = (f: number, width = 20) => {
  const w40 = width === 40;
  if (f < 3.7e9) {
    if (!w40 && f > 2478e6) return 2484e6;
    const lo = w40 ? 2422e6 : 2412e6, n = w40 ? 8 : 12;
    return lo + Math.min(n, Math.max(0, Math.round((f - lo) / 5e6))) * 5e6;
  }
  return Math.min(w40 ? 6155e6 : 6165e6, Math.max(w40 ? 5090e6 : 5080e6, Math.round(f / 5e6) * 5e6));
};
const UDEV_CMD = 'sudo cp tools/99-wsdr.rules /etc/udev/rules.d/ && sudo udevadm control --reload';
const LOCKED = 'End the recording to change tuning or gain';

// Per-viewer preferences (display only); storage may be unavailable.
const PREFS_KEY = 'wsdr-studio.prefs';
type Scale = { dbMin: number; dbMax: number; wfFloor: number };
type Tuning = { freq: number; rate_sel: number; gain_db: number; agc: boolean };
type Prefs = { smooth: number; wfMode: 'max' | 'avg'; scale: Scale | null; retuned: boolean; tuning: Tuning | null };
function loadPrefs(): Prefs {
  const d: Prefs = { smooth: 0.7, wfMode: 'max', scale: null, retuned: false, tuning: null };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return d;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private window */
  }
}

type Banner = { id: number; text: string; kind: 'info' | 'error' };
type Saved = { file: string; bytes: number; seconds: number; reason?: string; error?: string };

// A number box that applies on Enter or when leaving the field (not on every keystroke).
function NumField({ value, onCommit, title }: { value: number; onCommit: (v: number) => void; title: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    const v = Number(text);
    if (text !== null && text.trim() !== '' && Number.isFinite(v)) onCommit(v);
    setText(null);
  };
  return (
    <input
      className="num"
      value={text ?? String(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      title={title}
    />
  );
}

export default function App() {
  const clientRef = useRef<Client | null>(null);
  const spRef = useRef<HTMLCanvasElement>(null);
  const wfRef = useRef<HTMLCanvasElement>(null);
  const display = useRef<Display | null>(null);
  const freqFocused = useRef(false);
  const lastSentFreq = useRef<number | null>(null);
  const gainTimer = useRef<number | undefined>(undefined);
  const rate = useRef({ banks: 0, t: 0 });
  const drops = useRef({ ring: 0, client: 0, at: 0 });
  const bannerId = useRef(1);
  const live = useRef({ open: false, recording: false, opening: false, freq: 5180e6, width: 20 }); // for callbacks that outlive a render
  const autoOn = useRef(loadPrefs().scale === null); // Auto scale on (mirrors prefs.scale === null; storage may be blocked)
  const [home, setHome] = useState('');
  const setRef = useRef<(a: Partial<RxSettings>) => void>(() => {});
  const popRef = useRef<HTMLDivElement>(null);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [connected, setConnected] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps>({ open: false });
  const [rx, setRx] = useState<RxSettings | null>(null); // live settings (adapter open)
  // the last tuning (remembered across launches) is the first draft
  const [draft, setDraft] = useState<RxSettings>(() => ({ freq: 5180e6, rate_sel: 4, agc: false, gain_db: 30, ...loadPrefs().tuning, wide: true }));
  const [dsp, setDsp] = useState<DspSettings>({ fft: 8192, rows_per_s: 25, paths: 'a', dc_remove: true });
  const [status, setStatus] = useState<Status | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [starting, setStarting] = useState(false);
  const [scale, setScale] = useState<Scale>(prefs.scale ?? { dbMin: -110, dbMax: -20, wfFloor: -100 });
  const [showDisplay, setShowDisplay] = useState(false);
  const [freqText, setFreqText] = useState(() => mhz(draft.freq, 3));
  const [gainUi, setGainUi] = useState<number | null>(null);
  const [msps, setMsps] = useState(0);
  const [dropWarn, setDropWarn] = useState<string[]>([]);
  const [hadPicture, setHadPicture] = useState(false);

  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((old) => {
      const n = { ...old, ...p };
      savePrefs(n);
      return n;
    });
  const setUserScale = (s: Scale) => {
    autoOn.current = false; // at once: a row arriving before the effect must not refit over it
    const dbMin = Math.min(s.dbMin, s.dbMax - 10);
    const n = { dbMin, dbMax: Math.max(s.dbMax, dbMin + 10), wfFloor: s.wfFloor };
    setScale(n);
    updatePrefs({ scale: n }); // a scale the user chose survives restarts (no automatic refit)
  };
  const addBanner = (text: string, kind: Banner['kind'] = 'info') => {
    const id = bannerId.current++;
    setBanners((b) => [...b.filter((x) => x.text !== text), { id, text, kind }]);
    if (kind === 'info') window.setTimeout(() => setBanners((b) => b.filter((x) => x.id !== id)), 6000);
  };
  const dropBanner = (id: number) => setBanners((b) => b.filter((x) => x.id !== id));
  const req = (cmd: string, args: Record<string, unknown> = {}) =>
    (clientRef.current ? clientRef.current.request(cmd, args) : Promise.reject(new Error('not connected'))).catch(
      (e: Error & { kind?: string }) => {
        addBanner(e.message, e.kind === 'busy' ? 'info' : 'error'); // "try again in a moment" is not a fault
        throw e;
      },
    );

  // socket + display wiring (the effect owns the client and the renderer)
  useEffect(() => {
    let disposed = false;
    const d = new Display(spRef.current!, wfRef.current!);
    display.current = d;
    const ro = new ResizeObserver(() => d.resize());
    ro.observe(spRef.current!);
    ro.observe(wfRef.current!);
    d.resize();
    // Auto scale: refit once enough rows of a new setting have arrived (Start, retune, gain change),
    // unless the user fixed the scale. autoAt = the row count to refit at (-1: nothing pending).
    // Auto refit: after Start; after an rx change once 25 rows of the NEW run arrived (rows of the old
    // run may still be in flight); after a display change (FFT) once 25 more rows arrived.
    let autoAt = autoOn.current ? 25 : -1;
    let autoRun = -1; // run count to wait for (-1: none)
    const autoAgain = (rx: boolean) => {
      if (!autoOn.current) return;
      if (rx) {
        autoRun = d.runCount() + 1;
        autoAt = -1; // rows still counting toward an earlier trigger may be of the old run
      } else {
        d.resetPeaks();
        autoAt = d.rowsSeen() + 25;
      }
    };
    d.onHint = (t) => addBanner(t);
    let wasOpen = false;
    let lastRx: RxSettings | null = null;
    let lastPaths = 'a';
    let lastFft = 0;
    let client: Client | null = null;
    d.onRetune = (f) => {
      if (live.current.recording || live.current.opening) {
        if (live.current.recording) addBanner(LOCKED);
        return;
      }
      const t = snap(f, live.current.width);
      if (Math.abs(t - live.current.freq) < 1) addBanner(`Already at the nearest step (${mhz(t, 0)} MHz). The radio tunes in 5 MHz steps.`);
      else {
        addBanner(`${live.current.open ? 'Tuned to' : 'Next Start:'} ${mhz(t, 0)} MHz (nearest 5 MHz step)`);
        setRef.current({ freq: t }); // live retune, or the draft for the next Start when stopped
      }
      updatePrefs({ retuned: true });
    };
    Client.fromLocation()
      .then((c) => {
        if (disposed) return;
        client = c;
        clientRef.current = c;
        c.onRow = (r) => {
          d.push(r);
          const runDone = autoRun >= 0 && d.runCount() >= autoRun && d.runRows() >= 25;
          const rowsDone = autoAt >= 0 && d.rowsSeen() >= autoAt;
          if (runDone || rowsDone) {
            if (runDone) autoRun = -1; // clear only the trigger that fired
            if (rowsDone) autoAt = -1;
            if (!autoOn.current) return; // the user fixed a scale meanwhile
            const s = d.suggestRange();
            if (s) setScale(s);
          }
        };
        c.onConnection = (up) => {
          setConnected(up);
          if (!up) wasOpen = false; // the radio may be stopped and restarted elsewhere meanwhile: the next caps is a fresh Start
        };
        c.onGiveUp = (why) => setFatal(why);
        c.onEvent = (e) => {
          switch (e.type) {
            case 'devices':
              setDevices(e.devices);
              setSelKey((k) => (k !== null && e.devices.some((x: Device) => devKey(x) === k) ? k : e.devices[0] ? devKey(e.devices[0]) : null));
              break;
            case 'caps':
              // the picker shows the adapter that is open, whoever opened it
              if (e.open && e.bus !== undefined && e.bus >= 0) setSelKey(`${e.bus}-${e.port}`);
              if (e.open && !wasOpen) {
                lastRx = null; // the new session's first settings are not a change (Auto refits on Start)
                setSaved(null); // also when another window or script pressed Start
                d.newStream();
                autoAt = autoOn.current ? 25 : -1;
                autoRun = -1;
              } else if (!e.open && wasOpen) {
                setHadPicture(d.hasPicture());
                d.freeze();
                if (lastRx) setDraft(lastRx); // keep the last settings for the next Start
                setRx(null);
              }
              wasOpen = e.open;
              live.current.open = e.open;
              setCaps(e);
              break;
            case 'settings':
              if (e.rx) {
                if (lastRx && (lastRx.freq !== e.rx.freq || lastRx.rate_sel !== e.rx.rate_sel || lastRx.gain_db !== e.rx.gain_db || lastRx.agc !== e.rx.agc))
                  autoAgain(true);
                if (lastRx && lastRx.freq !== e.rx.freq) updatePrefs({ retuned: true });
                updatePrefs({ tuning: { freq: e.rx.freq, rate_sel: e.rx.rate_sel, gain_db: e.rx.gain_db, agc: e.rx.agc } });
                lastRx = e.rx;
                setRx(e.rx);
                lastSentFreq.current = null;
                if (!freqFocused.current) setFreqText(mhz(e.rx.freq, 3));
                setGainUi(null);
              }
              if (e.dsp) {
                if (lastFft && e.dsp.fft !== lastFft && wasOpen) autoAgain(false); // stopped: keep the frozen picture
                lastFft = e.dsp.fft;
                if (e.dsp.paths !== lastPaths) {
                  if (!e.dsp.paths.includes('a')) d.dropPath(0);
                  if (!e.dsp.paths.includes('b')) d.dropPath(1);
                  lastPaths = e.dsp.paths;
                }
                setDsp(e.dsp);
              }
              break;
            case 'status': {
              setStatus(e);
              if (e.record?.active && !live.current.recording) {
                window.clearTimeout(gainTimer.current); // controls lock now
                setSaved((s) => (s && s.file === e.record.file ? s : null)); // a new recording (from any window) replaces the old note
              }
              live.current.recording = e.record?.active ?? false;
              const banks = e.rx?.banks ?? 0;
              const r = rate.current;
              if (r.t && e.t > r.t && banks >= r.banks) setMsps(((banks - r.banks) * 8192) / (e.t - r.t) / 1e6);
              r.banks = banks;
              r.t = e.t;
              // drop counters are cumulative: warn only while they are still growing (last 5 s)
              const dr = drops.current;
              const ring = e.ring_dropped ?? 0, cl = e.client_drops ?? 0;
              if (ring > dr.ring || cl > dr.client) dr.at = e.t;
              const w: string[] = [];
              if (e.t - dr.at < 5 && dr.at) {
                if (ring > dr.ring) w.push('banks dropped (DSP behind)');
                if (cl > dr.client) w.push('display skipped rows (window too slow)');
              }
              if (w.length || e.t - dr.at >= 5) setDropWarn(w);
              dr.ring = ring;
              dr.client = cl;
              break;
            }
            case 'hello':
              setHome(e.home ?? '');
              break;
            case 'recorded':
              setSaved({ file: e.file, bytes: e.bytes, seconds: e.seconds, reason: e.reason, error: e.error });
              break;
            case 'alert':
              addBanner(e.msg, 'error');
              break;
            case 'error':
              addBanner(e.msg ?? 'error', 'error');
              break;
          }
        };
        c.connect();
      })
      .catch((e: Error) => !disposed && setFatal(e.message));
    return () => {
      disposed = true;
      ro.disconnect();
      d.destroy();
      client?.close();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A remembered 40 MHz tuning on an adapter that cannot do it (USB 2, 8812CU): clamp the draft.
  const selDev = devices.find((d) => devKey(d) === selKey);
  const selMax = selDev?.max_msps ?? 40; // continuous: a remembered wide span never opens gapped by itself
  useEffect(() => {
    if (selMax < 40)
      setDraft((dr) => (dr.rate_sel < 4 ? { ...dr, rate_sel: 4 } : dr)); // every 40 MHz centre is also a 5 MHz step
  }, [selMax]);

  // Display popover: closes on Esc or a click outside it
  useEffect(() => {
    if (!showDisplay) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowDisplay(false);
    const onDown = (e: MouseEvent) => popRef.current && !popRef.current.contains(e.target as Node) && setShowDisplay(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [showDisplay]);

  const open = caps.open;
  const opening = status?.state === 'opening' || starting;
  const cur = rx ?? draft; // what the controls show
  const sel = devices.find((d) => devKey(d) === selKey);
  const rxState = open ? status?.rx?.state ?? 'starting' : 'stopped';
  const recording = status?.record.active ?? false;
  const locked = (open && recording) || opening; // recording: a change would end the file; opening: it would be lost

  const fsNow = 80e6 / (1 << cur.rate_sel);
  const width = cur.rate_sel === 1 && (caps.wide_capable ?? true) ? 40 : 20;
  const chan = channelAt(cur.freq, 20); // by centre frequency only (the span does not pick a channel)
  const rates = caps.rates ?? ratesFor(sel);
  // the selected span (follows a change at once; the footer shows the run's measured share)
  const gapped = rates.find((r) => r.rate_sel === cur.rate_sel)?.gapped ?? false;
  const run = status?.rx;
  const gappedPct = run?.gapped && msps > 0 && run.fs ? Math.round(((msps * 1e6) / run.fs) * 100) : null;
  const tuned = status?.rx?.centre ?? 0;
  useEffect(() => {
    live.current.opening = opening;
    live.current.freq = cur.freq;
    live.current.width = width;
  }, [opening, cur.freq, width]);
  useEffect(() => {
    autoOn.current = prefs.scale === null;
  }, [prefs.scale]);
  // Closing the window while recording: the shell asks first (Electron 'will-prevent-unload').
  useEffect(() => {
    if (!recording) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [recording]);
  const offGrid = open && tuned > 0 && Math.abs(tuned - cur.freq) > 1e3;

  const overlay = fatal
    ? fatal
    : !connected
      ? 'Connecting to wsdr-studio…'
      : opening
        ? 'Starting the adapter… (about 5 s)'
        : open
          ? null
          : !devices.length
            ? 'No adapter found. Plug in an RTL8812BU or RTL8812CU, then press ⟳ Rescan.'
            : hadPicture
              ? 'Stopped. Double-click the spectrum to pick a frequency; ▶ Start to resume.'
              : 'Stopped. Press ▶ Start to begin.';
  useEffect(
    () =>
      display.current?.setOpts({
        ...scale, wfMode: prefs.wfMode, smooth: prefs.smooth, overlay, dim: !open,
        wfPath: dsp.paths === 'b' ? 1 : 0, marker: open || hadPicture ? cur.freq : null,
        markerLabel: open ? 'requested' : 'next Start',
        chipNotch: (caps.chip ?? sel?.chip ?? '').includes('8822C'),
        badge: open && run?.gapped ? `GAPPED · ${gappedPct !== null ? `~${gappedPct} %` : 'part of the time'} sampled` : null,
        staleText: rxState === 'starting' ? 'Applying settings…' : 'No data from the adapter',
      }),
    [scale, prefs.wfMode, prefs.smooth, overlay, open, dsp.paths, cur.freq, hadPicture, rxState, caps.chip, sel?.chip, run?.gapped, gappedPct],
  );

  // A settings change: sent now when streaming, kept as a draft until Start otherwise.
  const set = (args: Partial<RxSettings>) => {
    if (!live.current.open) {
      const n = { ...draft, ...args };
      setDraft(n);
      updatePrefs({ tuning: { freq: n.freq, rate_sel: n.rate_sel, gain_db: n.gain_db, agc: n.agc } }); // remembered too
      if (args.freq !== undefined) setFreqText(mhz(args.freq, 3));
      return;
    }
    req('set', args).catch(() => {});
  };
  useEffect(() => {
    setRef.current = set;
  });
  const doStart = async () => {
    if (!sel) return;
    setStarting(true);
    setSaved(null);
    window.clearTimeout(gainTimer.current); // a gain change still waiting goes with the open
    const gain = gainUi ?? draft.gain_db;
    try {
      await req('open', { pid: sel.pid, bus: sel.bus, port: sel.port, ...draft, gain_db: gain });
    } catch {
      /* shown */
    } finally {
      setStarting(false);
    }
  };
  const pickChannel = (key: string) => {
    const c = CHANNELS.find((x) => channelKey(x) === key);
    if (!c) return;
    updatePrefs({ retuned: true }); // the tip is no longer needed
    // A channel only moves the centre; the width shown is Span / rate alone.
    if (fsNow < c.width * 1e6 - 1)
      addBanner(`Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel; widen it with Span / rate`);
    set({ freq: c.centre });
  };
  const commitFreq = () => {
    const f = Math.round(parseFloat(freqText) * 1e6);
    if (!Number.isFinite(f) || f < 2.3e9 || f > 6.2e9) {
      setFreqText(mhz(cur.freq, 3));
      if (freqText.trim()) addBanner('Frequency must be between 2300 and 6200 MHz', 'error');
      return;
    }
    const t = snap(f, width); // the radio tunes in 5 MHz steps
    if (t !== f) addBanner(`Tuned to ${mhz(t, 3)} MHz (the radio tunes in 5 MHz steps)`);
    setFreqText(mhz(t, 3));
    if (t === lastSentFreq.current || Math.abs(t - cur.freq) < 1) return; // Enter then blur: send once
    lastSentFreq.current = t;
    updatePrefs({ retuned: true });
    set({ freq: t });
  };
  const onGain = (v: number) => {
    setGainUi(v);
    window.clearTimeout(gainTimer.current);
    gainTimer.current = window.setTimeout(() => set({ gain_db: v }), 200);
  };
  const toggleRecord = async () => {
    try {
      await req('record', { action: recording ? 'stop' : 'start' });
      if (!recording) setSaved(null);
    } catch {
      /* shown */
    }
  };
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => addBanner('Copied')).catch(() => {});

  // status line: always the essentials; diagnostics only when they are abnormal
  const st = status?.rx;
  const warn: string[] = [...dropWarn];
  if (open && st) {
    if (st.restarts > 0) warn.push(`${st.restarts} stream restart${st.restarts > 1 ? 's' : ''}`);
    if (status!.dsp_load > 0.8) warn.push(`DSP ${(status!.dsp_load * 100).toFixed(0)} %`);
    if (rxState === 'streaming' && st.fs && !st.gapped && msps > 0 && msps < 0.95 * (st.fs / 1e6)) warn.push(`input ${msps.toFixed(2)} MS/s`);
  }
  const dotClass =
    fatal || !connected ? 'dot bad'
    : opening || (rxState === 'starting' && !st?.error) ? 'dot warn' // a routine restart (retune, span) is not a fault
    : !open ? 'dot'
    : rxState === 'streaming' ? 'dot ok'
    : 'dot bad';
  const stateText = fatal ? 'disconnected' : !connected ? 'connecting…' : opening ? 'starting…' : open ? rxState : 'stopped';
  const recRate = fsNow * 4; // bytes/s (int16 I + Q)
  const diskFree = status?.disk_free ?? 0;
  const secsLeft = diskFree / recRate;

  return (
    <div className="app">
      <header className="bar">
        <div className="group">
          <span className="brand">wsdr-studio</span>
          <select value={selKey ?? ''} disabled={open || opening || !devices.length} onChange={(e) => setSelKey(e.target.value)} title={sel ? devTitle(sel) : 'Adapter'}>
            {!devices.length && <option value="">no adapter found</option>}
            {devices.map((d) => (
              <option key={devKey(d)} value={devKey(d)} title={devTitle(d)}>
                {devLabel(d)}
              </option>
            ))}
          </select>
          {!open ? (
            <button className="primary" disabled={!sel || opening || !connected || !sel.can_open} onClick={doStart}>
              {opening ? 'Starting…' : '▶ Start'}
            </button>
          ) : (
            <button
              className={recording ? '' : 'stop'}
              onClick={() => req('close').catch(() => {})}
              title={recording ? 'Stop the radio (also ends and saves the recording)' : 'Stop the radio'}
            >
              {recording ? '■ Stop radio' : '■ Stop'}
            </button>
          )}
          {open ? (
            <button
              className={recording ? 'rec on' : 'rec'}
              disabled={!recording && (rxState !== 'streaming' || gapped)}
              onClick={toggleRecord}
              title={
                !recording && gapped
                  ? 'Recording needs a continuous span (5 MHz or less on this adapter); gapped spans sample only part of the time'
                  : !recording && rxState !== 'streaming'
                  ? 'Available while streaming'
                  : `Record raw IQ (SigMF), about ${bytes(recRate)}/s at this span${diskFree ? `; ${bytes(diskFree)} free (~${fmtDur(diskFree / recRate)})` : ''}`
              }
            >
              {recording ? '■ End recording' : gapped ? '● Record (≤ 5 MHz)' : '● Record'}
            </button>
          ) : (
            <button className="scan" disabled={opening || !connected} onClick={() => req('scan').catch(() => {})} title="Look for adapters again">
              ⟳ Rescan
            </button>
          )}
        </div>

        <div className="group" title={locked ? LOCKED : undefined}>
          <label htmlFor="ch">Channel</label>
          <select
            id="ch"
            disabled={locked}
            value={chan ? channelKey(chan) : ''}
            onChange={(e) => pickChannel(e.target.value)}
            title="Sets the centre frequency only; how wide a slice you see is Span / rate"
          >
            <option value="" disabled>
              custom
            </option>
            <optgroup label="2.4 GHz">
              {CHANNELS.filter((c) => c.band === '2.4').map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
              ))}
            </optgroup>
            <optgroup label="5 GHz">
              {CHANNELS.filter((c) => c.band === '5' && c.width === 20).map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
              ))}
            </optgroup>
            <optgroup label="5 GHz · centre of a 40 MHz pair">
              {CHANNELS.filter((c) => c.width === 40).map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.ch + 2} · ${mhz(c.centre, 0)} MHz (centre of ${c.label})`}</option>
              ))}
            </optgroup>
          </select>
          <input
            className="freq"
            disabled={locked}
            value={freqText}
            onFocus={() => {
              freqFocused.current = true;
              lastSentFreq.current = null;
            }}
            onChange={(e) => setFreqText(e.target.value)}
            onBlur={() => {
              freqFocused.current = false;
              commitFreq();
            }}
            onKeyDown={(e) => e.key === 'Enter' && commitFreq()}
            title="Centre frequency in MHz (Enter to apply). The radio tunes in 5 MHz steps."
          />
          <span className="unit">MHz</span>
        </div>

        <div className="group" title={locked ? LOCKED : undefined}>
          <label htmlFor="span">Span / rate</label>
          <select
            id="span"
            disabled={locked}
            value={cur.rate_sel}
            onChange={(e) => {
              const rs = Number(e.target.value);
              const w = rs === 1 && (caps.wide_capable ?? true) ? 40 : 20;
              const f = snap(cur.freq, w); // a 40 MHz span is centred on a channel pair (radio limit)
              if (Math.abs(f - cur.freq) > 1) {
                const p = channelAt(f, 40);
                addBanner(`40 MHz spans are centred on channel pairs: now ${mhz(f, 0)} MHz${p ? ` (${p.label})` : ''}`);
                setFreqText(mhz(f, 3));
              }
              set({ rate_sel: rs, wide: true, freq: f });
            }}
            title={`Bandwidth shown = sample rate (complex IQ). This adapter: up to ${spanLabel(Math.max(...rates.map((r) => r.fs)))}${
              sel && sel.max_msps < 40 && sel.model === 'RTL8812BU' ? ' (10-40 MHz need USB 3)' : ''
            }${
              rates.some((r) => r.gapped)
                ? '. "gapped": wider than USB 2 can carry continuously; the adapter captures short slices (spectrum and waterfall, no recording)'
                : ''
            }`}
          >
            {rates.map((r) => (
              <option key={r.rate_sel} value={r.rate_sel}>
                {r.gapped
                  ? `${spanLabel(r.fs)} · gapped (~${Math.round(gappedDuty(r.fs) * 100)} % sampled)`
                  : `${spanLabel(r.fs)} · ${r.fs / 1e6} MS/s`}
              </option>
            ))}
          </select>
        </div>

        <div className="group" title={locked ? LOCKED : undefined}>
          <label htmlFor="gain">Gain</label>
          <input
            id="gain"
            type="range"
            disabled={cur.agc || locked}
            min={0}
            max={caps.gain_max ?? 49}
            step={caps.gain_step ?? 1}
            value={gainUi ?? cur.gain_db}
            onChange={(e) => onGain(Number(e.target.value))}
          />
          <span className="val">{cur.agc ? 'auto' : `${(gainUi ?? cur.gain_db).toFixed(0)} dB`}</span>
          <label className="check" title="Let the chip's AGC set the gain (it steps down during frames)">
            <input type="checkbox" disabled={locked} checked={cur.agc} onChange={(e) => set({ agc: e.target.checked })} />
            AGC
          </label>
        </div>

        {caps.paths === 2 && (
          <div className="group">
            <label>Antenna</label>
            {(['a', 'b', 'ab'] as const).map((p) => (
              <button key={p} className={dsp.paths === p ? 'on' : ''} disabled={locked} onClick={() => req('dsp', { paths: p }).catch(() => {})}>
                {p === 'ab' ? 'A+B' : p.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        <div className="group">
          <label>Scale</label>
          <NumField value={scale.dbMin} title="Bottom of the scale (dBFS); Enter to apply" onCommit={(v) => setUserScale({ ...scale, dbMin: v })} />
          <span className="unit">to</span>
          <NumField value={scale.dbMax} title="Top of the scale (dBFS); Enter to apply" onCommit={(v) => setUserScale({ ...scale, dbMax: v })} />
          <span className="unit">dBFS</span>
          <button
            className={prefs.scale === null ? 'on' : ''}
            title={
              prefs.scale === null
                ? 'Auto scale is on: refits after Start, retune, span, gain or FFT change. Type a value to fix the scale.'
                : 'Fit the scale to the signal now, and keep refitting after Start, retune, span, gain or FFT changes'
            }
            onClick={() => {
              const s = display.current?.suggestRange();
              if (s) setScale(s);
              updatePrefs({ scale: null });
            }}
          >
            Auto
          </button>
          <div className="popover-anchor" ref={popRef}>
            <button className={showDisplay ? 'on' : ''} onClick={() => setShowDisplay((v) => !v)} aria-expanded={showDisplay}>
              Display ▾
            </button>
            {showDisplay && (
              <div className="popover">
                <label>
                  FFT size
                  <select value={dsp.fft} onChange={(e) => req('dsp', { fft: Number(e.target.value) }).catch(() => {})}>
                    {FFTS.map((n) => (
                      <option key={n} value={n} disabled={gapped && n > 8192}>
                        {n <= 4096 ? `${n} (${(fsNow / n / 1e3).toFixed(1)} kHz/bin)` : `${n} (${(fsNow / 4096 / 1e3).toFixed(1)} kHz/bin, smoother noise)`}
                        {gapped && n > 8192 ? ' – not in gapped mode (8192 used)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Averaging
                  <select value={prefs.smooth} onChange={(e) => updatePrefs({ smooth: Number(e.target.value) })}>
                    <option value={0}>off</option>
                    <option value={0.5}>low</option>
                    <option value={0.7}>medium</option>
                    <option value={0.9}>high</option>
                  </select>
                </label>
                <label>
                  Waterfall
                  <select
                    value={prefs.wfMode}
                    onChange={(e) => {
                      updatePrefs({ wfMode: e.target.value as 'max' | 'avg' });
                      if (autoOn.current) {
                        // the floor depends on the mode: refit right away when Auto is on
                        display.current?.setOpts({ wfMode: e.target.value as 'max' | 'avg' });
                        const s = display.current?.suggestRange();
                        if (s) setScale(s);
                      }
                    }}
                  >
                    <option value="max">peak (shows short frames)</option>
                    <option value="avg">average</option>
                  </select>
                </label>
                <label>
                  Waterfall floor
                  <span>
                    <NumField value={scale.wfFloor} title="Colour of the waterfall starts here (dBFS)" onCommit={(v) => setUserScale({ ...scale, wfFloor: v })} /> dBFS
                  </span>
                </label>
                <span className="note">Esc or a click outside closes this.</span>
              </div>
            )}
          </div>
        </div>
      </header>

      {recording && status && (
        <div className="strip rec">
          ● REC {status.record.seconds.toFixed(1)} s · {bytes(status.record.bytes)} · {bytes(recRate)}/s → <code title={status.record.file}>{baseName(status.record.file)}</code>
          {diskFree > 0 && (
            <span className={secsLeft < 60 ? 'warn' : 'muted'}>
              {bytes(diskFree)} free (~{fmtDur(secsLeft)})
            </span>
          )}
          <span className="muted">tuning and gain locked</span>
        </div>
      )}
      {!recording && saved && (
        <div className={saved.error ? 'strip error' : 'strip'}>
          <span className="one-line" title={saved.file}>
            {saved.error ? `Recording stopped: ${saved.error}. ` : saved.reason ? `Recording stopped (${saved.reason}). ` : ''}
            Saved <code>{baseName(saved.file)}</code> · {bytes(saved.bytes)} · {saved.seconds.toFixed(1)} s · in{' '}
            {home && saved.file.startsWith(home + '/')
              ? '~' + saved.file.slice(home.length, saved.file.lastIndexOf('/') + 1)
              : saved.file.slice(0, saved.file.lastIndexOf('/') + 1)}
          </span>
          <button onClick={() => copy(saved.file)}>Copy path</button>
          <button className="x" onClick={() => setSaved(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}
      {sel && !sel.can_open && !open && (
        <div className="strip error">
          No permission to open the {sel.model}. Run once (in the wifi-sdr folder), then replug: <code>{UDEV_CMD}</code>
          <button onClick={() => copy(UDEV_CMD)}>Copy command</button>
        </div>
      )}
      {sel && sel.driver && sel.driver !== 'usbfs' && !open && (
        <div className="strip">
          The kernel driver <code>{sel.driver}</code> is using this adapter; ▶ Start takes it over.
        </div>
      )}
      {sel && sel.pid === 0xb812 && sel.speed_mbps < 5000 && !open && (
        <div className="strip">This 8812BU is connected at USB 2 speed: spans up to 5 MHz. 40 MHz needs a USB 3 connection.</div>
      )}
      {banners
        .filter((b) => b.kind === 'error')
        .map((b) => (
          <div key={b.id} className="strip error">
            {b.text}
            <button className="x" onClick={() => dropBanner(b.id)} title="Dismiss">
              ×
            </button>
          </div>
        ))}

      <main className="plots">
        <div className="toasts">
          {banners
            .filter((b) => b.kind === 'info')
            .map((b) => (
              <div key={b.id} className="toast" onClick={() => dropBanner(b.id)}>
                {b.text}
              </div>
            ))}
        </div>
        <canvas ref={spRef} className="spectrum" />
        <canvas ref={wfRef} className="waterfall" />
      </main>

      <footer className="status">
        <span className={dotClass} />
        <span>{stateText}</span>
        {!open && !opening && connected && sel && (
          <span className="muted">
            next Start: {chan ? `${chanName(chan)} · ` : ''}
            {mhz(cur.freq)} MHz · {spanLabel(fsNow)} span
          </span>
        )}
        {open && st && (
          <span>
            {chan && !offGrid ? `${chanName(chan)} · ` : ''}
            {offGrid ? `${mhz(cur.freq)} MHz requested · tuned ${mhz(tuned)} MHz (5 MHz steps)` : `${mhz(cur.freq)} MHz`} · {spanLabel(st.fs)} span
            {st.gapped && (
              <span className="muted" title="Each slice is 8192 samples; the gaps between them are the time USB 2 needs to ship one">
                {' '}· gapped: {gappedPct !== null ? `~${gappedPct} %` : '…'} of the time sampled
              </span>
            )}
          </span>
        )}
        {warn.map((w) => (
          <span key={w} className="warn">
            {w}
          </span>
        ))}
        {status?.rx?.error && <span className="warn">{status.rx.error}</span>}
        {!open && status?.error && <span className="warn">{status.error}</span>}
        {!prefs.retuned && open && !recording && <span className="hint">tip: double-click the spectrum to tune there</span>}
      </footer>
    </div>
  );
}
