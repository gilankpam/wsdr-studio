// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState } from 'react';
import { CHANNELS, channelAt, channelKey, type Channel } from './channels';
import { Tuner } from './Tuner';
import { Display } from './display';
import { Client, type Caps, type Device, type DspSettings, type Rate, type RxSettings, type Status } from './protocol';

const FFTS = [1024, 2048, 4096, 8192, 16384];
const RATES: Rate[] = [5, 4, 3, 2, 1].map((r) => ({ rate_sel: r, fs: 80e6 / (1 << r) }));
// What an adapter offers before Start (after Start the backend's caps say it).
const ratesFor = (d: Device | undefined, offsetTuning: boolean): Rate[] =>
  d
    ? RATES.filter((r) => r.fs <= d.max_msps * 1e6 || r.fs <= (d.gapped_msps ?? 0) * 1e6).map((r) => {
        const gapped = r.fs > d.max_msps * 1e6;
        // as the backend: with offset tuning the 8812CU's 10/20 MHz gapped views come from a 40 MHz capture
        return { ...r, gapped, hw_fs: gapped && offsetTuning && d.chip.includes('8822C') && r.fs <= 20e6 ? 40e6 : r.fs };
      })
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
// (At a 40 MHz span the radio centres within 2422-2462 / 5090-6155 MHz; the request stays and is marked.)
const snap = (f: number) => {
  if (f < 3.7e9) {
    if (f > 2478e6) return 2484e6;
    return 2412e6 + Math.min(12, Math.max(0, Math.round((f - 2412e6) / 5e6))) * 5e6;
  }
  return Math.min(6165e6, Math.max(5080e6, Math.round(f / 5e6) * 5e6));
};
const UDEV_CMD = 'sudo cp tools/99-wsdr.rules /etc/udev/rules.d/ && sudo udevadm control --reload';
const LOCKED = 'End the recording to change tuning or gain';

// Per-viewer preferences (display only); storage may be unavailable.
const PREFS_KEY = 'wsdr-studio.prefs';
type Scale = { dbMin: number; dbMax: number; wfFloor: number };
type Tuning = { freq: number; rate_sel: number; gain_db: number; agc: boolean };
type Locks = { freq: boolean; span: boolean; gain: boolean };
type Prefs = {
  smooth: number; wfMode: 'max' | 'avg'; scale: Scale | null; retuned: boolean;
  tuning: Tuning | null; tuningB: Tuning | null; // the last tuning of view A / B
  dual: boolean; locks: Locks; ghost: boolean;   // dual-adapter mode
  offsetTuning: boolean;                          // off: show what the adapter sees (notch included)
  layout: 'row' | 'column';                       // dual: side by side (channel order) or stacked
};
function loadPrefs(): Prefs {
  const d: Prefs = {
    smooth: 0.7, wfMode: 'max', scale: null, retuned: false, tuning: null, tuningB: null,
    dual: false, locks: { freq: true, span: true, gain: false }, ghost: true, offsetTuning: false, layout: 'row',
  };
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

// What the views share (display preferences, the scale) and how a view reaches the other (locks).
type Shared = { prefs: Prefs; updatePrefs: (p: Partial<Prefs>) => void; scale: Scale; setScale: (s: Scale) => void };
type StationHandle = {
  linkedSet: (args: Partial<RxSettings>) => void; // a change from the other view (no further forwarding)
  req: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  freq: () => number;
  open: () => boolean;
  suggest: (wfMode?: 'max' | 'avg') => Scale | null; // Auto scale from this view's picture
  busy: () => string | null; // why a linked change must not touch this view now (recording, starting)
  notice: (text: string) => void;
};
type ViewInfo = { fft: number; gapped: boolean; fsNow: number };
type Link = {
  ghost: boolean;                                              // draw the other view's average
  userSet: (slot: number, args: Partial<RxSettings>) => void;  // a user change: locked fields go to the other view
  dsp: (args: Record<string, unknown>) => void;                // shared display settings: both views
  register: (slot: number, h: StationHandle | null) => void;
  report: (v: ViewInfo) => void;                               // view A's FFT/span, for the app bar
};

// Scale, Auto and the Display popover: per view in single mode, in the app bar (shared) in dual mode.
function ViewControls(p: {
  scale: Scale; prefs: Prefs; updatePrefs: (x: Partial<Prefs>) => void; setUserScale: (s: Scale) => void;
  onAuto: () => void; onWfMode: (m: 'max' | 'avg') => void; fft: number; onFft: (n: number) => void;
  gapped: boolean; fsNow: number; shared?: boolean;
}) {
  const { scale, prefs, updatePrefs, setUserScale, gapped, fsNow } = p;
  const [show, setShow] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  // closes on Esc or a click outside it
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShow(false);
    const onDown = (e: MouseEvent) => popRef.current && !popRef.current.contains(e.target as Node) && setShow(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [show]);
  return (
    <div className="group" title={p.shared ? 'Shared by both views' : undefined}>
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
        onClick={p.onAuto}
      >
        Auto
      </button>
      <div className="popover-anchor" ref={popRef}>
        <button className={show ? 'on' : ''} onClick={() => setShow((v) => !v)} aria-expanded={show}>
          Display ▾
        </button>
        {show && (
          <div className="popover">
            <label>
              FFT size
              <select value={p.fft} onChange={(e) => p.onFft(Number(e.target.value))}>
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
              <select value={prefs.wfMode} onChange={(e) => p.onWfMode(e.target.value as 'max' | 'avg')}>
                <option value="max">peak (shows short frames)</option>
                <option value="avg">average</option>
              </select>
            </label>
            <label className="check" title="Off: the view is what the adapter's own receiver sees, its centre notch included. On: the 8812CU's 10 and 20 MHz views are cut from a 40 MHz capture tuned beside the channel, so the notch stays out of view (less of the time is sampled).">
              <input type="checkbox" checked={prefs.offsetTuning} onChange={(e) => updatePrefs({ offsetTuning: e.target.checked })} />
              Avoid the chip&apos;s centre notch (8812CU, 10/20 MHz)
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
  );
}

// One adapter's view (slot 0 = A, 1 = B): its own socket, controls, spectrum and waterfall.
function Station({ slot, dual, shared, link }: { slot: number; dual: boolean; shared: Shared; link: Link }) {
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
  const narrowNoted = useRef(false);
  const live = useRef({ open: false, recording: false, opening: false, freq: 5180e6, width: 20 }); // for callbacks that outlive a render
  const autoOn = useRef(loadPrefs().scale === null); // Auto scale on (mirrors prefs.scale === null; storage may be blocked)
  const view = useRef({ dual, ghost: link.ghost }); // for the socket callbacks
  const [home, setHome] = useState('');
  const setRef = useRef<(a: Partial<RxSettings>) => void>(() => {});

  const { prefs, updatePrefs, scale, setScale } = shared;
  const [connected, setConnected] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps>({ open: false });
  const [rx, setRx] = useState<RxSettings | null>(null); // live settings (adapter open)
  // the last tuning (remembered across launches) is the first draft
  const [draft, setDraft] = useState<RxSettings>(() => ({
    freq: 5180e6, rate_sel: 4, agc: false, gain_db: 30, ...(slot ? loadPrefs().tuningB : loadPrefs().tuning), wide: true,
  }));
  const [dsp, setDsp] = useState<DspSettings>({ fft: 8192, rows_per_s: 25, paths: 'a', dc_remove: true });
  const [status, setStatus] = useState<Status | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [starting, setStarting] = useState(false);
  const [freqText, setFreqText] = useState(() => mhz(draft.freq, 3));
  const [gainUi, setGainUi] = useState<number | null>(null);
  const [msps, setMsps] = useState(0);
  const [dropWarn, setDropWarn] = useState<string[]>([]);
  const [hadPicture, setHadPicture] = useState(false);

  const rememberTuning = (t: Tuning) => updatePrefs(slot ? { tuningB: t } : { tuning: t });
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
    (clientRef.current ? clientRef.current.request(cmd, { ...args, slot }) : Promise.reject(new Error('not connected'))).catch(
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
      const t = snap(f); // the request stays; at a 40 MHz span the radio centres as near as it can
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
          if (r.slot !== slot) {
            if (view.current.dual && view.current.ghost) d.setGhost(r);
            return;
          }
          d.push(r);
          const runDone = autoRun >= 0 && d.runCount() >= autoRun && d.runRows() >= 25;
          const rowsDone = autoAt >= 0 && d.rowsSeen() >= autoAt;
          if (runDone || rowsDone) {
            if (runDone) autoRun = -1; // clear only the trigger that fired
            if (rowsDone) autoAt = -1;
            if (!autoOn.current) return; // the user fixed a scale meanwhile
            if (view.current.dual && slot) return; // one shared scale: view A fits it
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
          if (e.slot !== undefined && e.slot !== slot) return; // the other view's
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
                rememberTuning({ freq: e.rx.freq, rate_sel: e.rx.rate_sel, gain_db: e.rx.gain_db, agc: e.rx.agc });
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
            case 'notice': // backend news for the user (e.g. the USB 3 switch)
              addBanner(String(e.text ?? ''));
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
  const rates = caps.rates ?? ratesFor(sel, prefs.offsetTuning);
  // the selected span (follows a change at once; the footer shows the run's measured share)
  const gapped = rates.find((r) => r.rate_sel === cur.rate_sel)?.gapped ?? false;
  const run = status?.rx;
  const hwFs = run?.hw_fs ?? run?.fs ?? 0;
  const gappedPct = run?.gapped && msps > 0 && hwFs ? Math.round(((msps * 1e6) / hwFs) * 100) : null;
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
        // the 8822B dips at its centre at 40 MHz on 2.4 GHz (measured: ~8-10 dB over +-1 MHz)
        notchWide: open && (caps.chip ?? '').includes('8822B') && (run?.hw_fs ?? run?.fs ?? 0) >= 40e6 && (run?.centre ?? 0) < 3.7e9,
        ghostLabel: `view ${slot ? 'A' : 'B'}`,
        badge: `GAPPED · ${gappedPct !== null ? `~${gappedPct} %` : 'part of the time'} sampled`, // shown on gapped rows
        staleText: rxState === 'starting' ? 'Applying settings…' : 'No data from the adapter',
      }),
    [scale, prefs.wfMode, prefs.smooth, overlay, open, dsp.paths, cur.freq, hadPicture, rxState, caps.chip, sel?.chip, run?.gapped, gappedPct, run?.fs, run?.hw_fs, run?.centre, slot],
  );

  // A settings change: sent now when streaming, kept as a draft until Start otherwise.
  const set = (args: Partial<RxSettings>) => {
    if (!live.current.open) {
      const n = { ...draft, ...args };
      setDraft(n);
      rememberTuning({ freq: n.freq, rate_sel: n.rate_sel, gain_db: n.gain_db, agc: n.agc }); // remembered too
      if (args.freq !== undefined) setFreqText(mhz(args.freq, 3));
      return;
    }
    req('set', args).catch(() => {});
  };
  // A change the user made here: applied, and offered to the other view (it takes the locked fields).
  const userSet = (args: Partial<RxSettings>) => {
    set(args);
    link.userSet(slot, args);
  };
  useEffect(() => {
    setRef.current = userSet;
    view.current = { dual, ghost: link.ghost };
    if (!link.ghost || !dual) display.current?.setGhost(null);
    link.register(slot, {
      linkedSet: set, req, freq: () => cur.freq, open: () => caps.open,
      suggest: (wfMode) => {
        if (wfMode) display.current?.setOpts({ wfMode });
        return display.current?.suggestRange() ?? null;
      },
      busy: () => (recording ? 'it is recording' : opening ? 'it is starting' : null),
      notice: (text) => addBanner(text),
    });
  });
  useEffect(() => () => link.register(slot, null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (slot === 0) link.report({ fft: dsp.fft, gapped, fsNow }); // for the app bar's shared controls
  }, [dsp.fft, gapped, fsNow]); // eslint-disable-line react-hooks/exhaustive-deps
  // the offset-tuning preference (shared) reaches a running adapter at once
  useEffect(() => {
    if (caps.open) req('set', { offset_tuning: prefs.offsetTuning }).catch(() => {});
  }, [prefs.offsetTuning]); // eslint-disable-line react-hooks/exhaustive-deps
  const doStart = async () => {
    if (!sel) return;
    setStarting(true);
    setSaved(null);
    window.clearTimeout(gainTimer.current); // a gain change still waiting goes with the open
    const gain = gainUi ?? draft.gain_db;
    try {
      await req('open', { pid: sel.pid, bus: sel.bus, port: sel.port, ...draft, gain_db: gain, offset_tuning: prefs.offsetTuning });
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
    // A channel only moves the centre; the width shown is Span / rate alone. Said once per session,
    // and only what this adapter can actually do.
    if (fsNow < c.width * 1e6 - 1 && !narrowNoted.current) {
      narrowNoted.current = true;
      const wider = rates.filter((r) => r.fs >= c.width * 1e6);
      addBanner(
        wider.some((r) => !r.gapped)
          ? `Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel; widen it with Span / rate`
          : wider.length
            ? `Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel; on this adapter wider spans are gapped (Span / rate)`
            : `Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel (the most this adapter shows)`,
      );
    }
    userSet({ freq: snap(c.centre) });
  };
  const commitFreq = () => {
    const f = Math.round(parseFloat(freqText) * 1e6);
    if (!Number.isFinite(f) || f < 2.3e9 || f > 6.2e9) {
      setFreqText(mhz(cur.freq, 3));
      if (freqText.trim()) addBanner('Frequency must be between 2300 and 6200 MHz', 'error');
      return;
    }
    const t = snap(f); // the radio tunes in 5 MHz steps
    if (t !== f) addBanner(`Tuned to ${mhz(t, 3)} MHz (the radio tunes in 5 MHz steps)`);
    setFreqText(mhz(t, 3));
    if (t === lastSentFreq.current || Math.abs(t - cur.freq) < 1) return; // Enter then blur: send once
    lastSentFreq.current = t;
    updatePrefs({ retuned: true });
    userSet({ freq: t });
  };
  const tuneTo = (f: number) => { // from the slider: same snapping as a typed frequency
    const t = snap(f);
    setFreqText(mhz(t, 3));
    lastSentFreq.current = t;
    updatePrefs({ retuned: true });
    userSet({ freq: t });
  };
  const onGain = (v: number) => {
    setGainUi(v);
    window.clearTimeout(gainTimer.current);
    gainTimer.current = window.setTimeout(() => userSet({ gain_db: v }), 200);
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
    <div className="station">
      <header className="bar">
        <div className="group">
          {dual && (
            <span className={`slotchip s${slot}`} title={`View ${slot ? 'B' : 'A'}`}>
              {slot ? 'B' : 'A'}
            </span>
          )}
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
              disabled={!recording && (rxState !== 'streaming' || gapped || !!run?.gapped)}
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
              // the centre stays as asked; a 40 MHz span centres within 2422-2462 / 5090-6155 MHz, so the
              // radio may sit beside it (the plot marks the requested frequency)
              userSet({ rate_sel: Number(e.target.value), wide: true });
            }}
            title={`Bandwidth shown = sample rate (complex IQ). This adapter: up to ${spanLabel(Math.max(...rates.map((r) => r.fs)))}${
              sel && sel.max_msps < 40 && sel.model === 'RTL8812BU' ? ' (continuous 10-40 MHz need USB 3)' : ''
            }${
              rates.some((r) => r.gapped)
                ? '. "gapped": wider than USB 2 can carry continuously; the adapter captures short slices (spectrum and waterfall, no recording)'
                : ''
            }`}
          >
            {rates.map((r) => (
              <option key={r.rate_sel} value={r.rate_sel}>
                {r.gapped
                  ? `${spanLabel(r.fs)} · gapped (~${Math.round(gappedDuty(r.hw_fs ?? r.fs) * 100)} % sampled)`
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
            <input type="checkbox" disabled={locked} checked={cur.agc} onChange={(e) => userSet({ agc: e.target.checked })} />
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

        {!dual && (
          <ViewControls
            scale={scale}
            prefs={prefs}
            updatePrefs={updatePrefs}
            setUserScale={setUserScale}
            onAuto={() => {
              const sg = display.current?.suggestRange();
              if (sg) setScale(sg);
              updatePrefs({ scale: null });
            }}
            onWfMode={(m) => {
              updatePrefs({ wfMode: m });
              if (autoOn.current) {
                // the floor depends on the mode: refit right away when Auto is on
                display.current?.setOpts({ wfMode: m });
                const sg = display.current?.suggestRange();
                if (sg) setScale(sg);
              }
            }}
            fft={dsp.fft}
            onFft={(n) => link.dsp({ fft: n })}
            gapped={gapped}
            fsNow={fsNow}
          />
        )}
      </header>
      <Tuner freq={cur.freq} disabled={locked} onTune={tuneTo} />

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
            {offGrid
              ? `${mhz(cur.freq)} MHz requested · tuned ${mhz(tuned)} MHz (${Math.abs(tuned - cur.freq) >= 4.99e6 ? 'nearest 40 MHz centre' : '5 MHz steps'})`
              : `${mhz(cur.freq)} MHz`}{' '}
            · {spanLabel(st.fs)} span
            {st.gapped && (
              <span className="muted" title="Each slice is 8192 samples; the gaps between them are the time USB 2 needs to ship one">
                {' '}· gapped: {gappedPct !== null ? `~${gappedPct} %` : '…'} of the time sampled
                {st.offset && st.hw_centre ? ` · radio at ${mhz(st.hw_centre)} MHz (keeps the chip notch out of view)` : ''}
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

// The window: one view (single) or two (dual), stacked. Shared: display preferences and the scale.
// Dual mode locks: a locked setting changed in one view is applied to the other (the frequency keeps
// the offset the views had when it was locked).
export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const p = loadPrefs();
    if (new URLSearchParams(location.search).get('dual') === '1') {
      p.dual = true; // started with --dual
      savePrefs(p);
    }
    return p;
  });
  const [scale, setScale] = useState<Scale>(() => loadPrefs().scale ?? { dbMin: -110, dbMax: -20, wfFloor: -100 });
  const handles = useRef<(StationHandle | null)[]>([null, null]);
  const [viewInfo, setViewInfo] = useState<ViewInfo>({ fft: 8192, gapped: false, fsNow: 5e6 });
  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((old) => {
      const n = { ...old, ...p };
      savePrefs(n);
      return n;
    });
  const { dual, locks } = prefs;
  const shared: Shared = { prefs, updatePrefs, scale, setScale };
  const link: Link = {
    ghost: prefs.ghost,
    register: (slot, h) => {
      handles.current[slot] = h;
    },
    report: setViewInfo,
    dsp: (args) =>
      handles.current.forEach((h, i) => {
        if (h && (i === 0 || dual)) h.req('dsp', args).catch(() => {});
      }),
    userSet: (slot, args) => {
      const other = dual ? handles.current[slot ^ 1] : null;
      const me = handles.current[slot];
      if (!other || !me) return;
      const name = slot ? 'A' : 'B';
      const a: Partial<RxSettings> = {};
      // the frequency lock keeps the views' distance as it is now (same frequency: compare; one span
      // apart: adjacent channels); the result is snapped to the tuning grid and must stay in its band
      const here = me.freq();
      if (locks.freq && args.freq !== undefined) {
        const want = args.freq + (other.freq() - here);
        const f = snap(want);
        if (Math.abs(f - want) > 2.5e6 || want < 3.7e9 !== other.freq() < 3.7e9)
          me.notice(`View ${name} cannot follow: ${(want / 1e6).toFixed(0)} MHz is outside its band`);
        else a.freq = f;
      }
      if (locks.span && args.rate_sel !== undefined) {
        a.rate_sel = args.rate_sel;
        a.wide = args.wide ?? true;
      }
      if (locks.gain && args.gain_db !== undefined) a.gain_db = args.gain_db;
      if (locks.gain && args.agc !== undefined) a.agc = args.agc;
      if (!Object.keys(a).length) return;
      const why = other.busy();
      if (why) me.notice(`View ${name} did not follow: ${why}`); // a recording must not be ended by a lock
      else other.linkedSet(a);
    },
  };
  const setLock = (k: keyof Locks) => updatePrefs({ locks: { ...locks, [k]: !locks[k] } });
  const setUserScale = (sc: Scale) => {
    const dbMin = Math.min(sc.dbMin, sc.dbMax - 10);
    const n = { dbMin, dbMax: Math.max(sc.dbMax, dbMin + 10), wfFloor: sc.wfFloor };
    setScale(n);
    updatePrefs({ scale: n });
  };
  const setDual = (on: boolean) => {
    if (!on && handles.current[1]?.open()) handles.current[1]?.req('close').catch(() => {});
    updatePrefs({ dual: on });
  };
  return (
    <div className={dual ? 'app dual' : 'app'}>
      <div className="appbar">
        <span className="brand">wsdr-studio</span>
        <div className="seg" title="One adapter, or two adapters stacked (A above B)">
          <button className={!dual ? 'on' : ''} onClick={() => setDual(false)}>
            Single
          </button>
          <button className={dual ? 'on' : ''} onClick={() => setDual(true)}>
            Dual
          </button>
        </div>
        {dual && (
          <>
            <div className="seg" title="Side by side: A then B in frequency order (adjacent channels). Stacked: A above B (compare one channel).">
              <button className={prefs.layout === 'row' ? 'on' : ''} onClick={() => updatePrefs({ layout: 'row' })}>
                Side by side
              </button>
              <button className={prefs.layout === 'column' ? 'on' : ''} onClick={() => updatePrefs({ layout: 'column' })}>
                Stacked
              </button>
            </div>
            <span className="muted">Lock A and B:</span>
            <button
              className={locks.freq ? 'on' : ''}
              onClick={() => setLock('freq')}
              title="Locked: retuning one view retunes the other by the same amount, keeping their distance (same frequency: compare one channel on two adapters; one span apart: adjacent channels)"
            >
              {locks.freq ? '🔒' : '🔓'} Frequency
            </button>
            <button className={locks.span ? 'on' : ''} onClick={() => setLock('span')} title="Locked: both views show the same span">
              {locks.span ? '🔒' : '🔓'} Span
            </button>
            <button className={locks.gain ? 'on' : ''} onClick={() => setLock('gain')} title="Locked: gain and AGC change together (two dongles' gains differ slightly)">
              {locks.gain ? '🔒' : '🔓'} Gain
            </button>
            <label className="check" title="Draw the other view's average trace over each spectrum while both show the same frequencies">
              <input type="checkbox" checked={prefs.ghost} onChange={(e) => updatePrefs({ ghost: e.target.checked })} />
              Overlay
            </label>
            <ViewControls
              shared
              scale={scale}
              prefs={prefs}
              updatePrefs={updatePrefs}
              setUserScale={setUserScale}
              onAuto={() => {
                const sg = handles.current[0]?.suggest();
                if (sg) setScale(sg);
                updatePrefs({ scale: null });
              }}
              onWfMode={(m) => {
                updatePrefs({ wfMode: m });
                if (prefs.scale === null) {
                  const sg = handles.current[0]?.suggest(m);
                  if (sg) setScale(sg);
                }
              }}
              fft={viewInfo.fft}
              onFft={(n) => link.dsp({ fft: n })}
              gapped={viewInfo.gapped}
              fsNow={viewInfo.fsNow}
            />
          </>
        )}
      </div>
      <div className={`views ${dual ? prefs.layout : 'column'}`}>
        <Station slot={0} dual={dual} shared={shared} link={link} />
        {dual && <Station slot={1} dual={dual} shared={shared} link={link} />}
      </div>
    </div>
  );
}
