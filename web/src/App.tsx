// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState } from 'react';
import { CHANNELS, channelAt, channelKey } from './channels';
import { Display } from './display';
import { Client, type Caps, type Device, type DspSettings, type RxSettings, type Status } from './protocol';

const FFTS = [1024, 2048, 4096, 8192, 16384];
const RATES = [5, 4, 3, 2, 1].map((r) => ({ rate_sel: r, fs: 80e6 / (1 << r) })); // before Start
const mhz = (hz: number, d = 1) => (hz / 1e6).toFixed(d);
const spanLabel = (fs: number) => `${fs / 1e6} MHz`;
const devKey = (d: Device) => `${d.bus}-${d.port}`;
const devLabel = (d: Device) => `${d.model} · ${d.speed_mbps >= 5000 ? 'USB 3' : 'USB 2'}`;
const devTitle = (d: Device) =>
  `${d.model} (${d.chip}), bus ${d.bus} port ${d.port}, ${d.speed_mbps} Mbit/s${d.controller ? `, host controller ${d.controller}` : ''}`;
const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`);
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
// The radio tunes in 5 MHz steps (2.4 GHz: 2407 + 5n MHz; 5 GHz: 5000 + 5n MHz).
const snap = (f: number) => (f < 3.7e9 ? 2407e6 + Math.round((f - 2407e6) / 5e6) * 5e6 : Math.round(f / 5e6) * 5e6);
const UDEV_CMD = 'sudo cp tools/99-wsdr.rules /etc/udev/rules.d/ && sudo udevadm control --reload';
const LOCKED = 'Stop recording to change tuning or gain';

// Per-viewer preferences (display only); storage may be unavailable.
const PREFS_KEY = 'wsdr-studio.prefs';
type Scale = { dbMin: number; dbMax: number; wfFloor: number };
type Prefs = { smooth: number; wfMode: 'max' | 'avg'; scale: Scale | null; retuned: boolean };
function loadPrefs(): Prefs {
  const d: Prefs = { smooth: 0.7, wfMode: 'max', scale: null, retuned: false };
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
type Saved = { file: string; bytes: number; seconds: number; reason?: string; error?: string; dropped: number };

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
  const live = useRef({ open: false, recording: false }); // for callbacks that outlive a render
  const popRef = useRef<HTMLDivElement>(null);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [connected, setConnected] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps>({ open: false });
  const [rx, setRx] = useState<RxSettings | null>(null); // live settings (adapter open)
  const [draft, setDraft] = useState<RxSettings>({ freq: 5180e6, rate_sel: 4, wide: true, agc: false, gain_db: 30 });
  const [dsp, setDsp] = useState<DspSettings>({ fft: 8192, rows_per_s: 25, paths: 'a', dc_remove: true });
  const [status, setStatus] = useState<Status | null>(null);
  const [banners, setBanners] = useState<Banner[]>([]);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [starting, setStarting] = useState(false);
  const [scale, setScale] = useState<Scale>(prefs.scale ?? { dbMin: -110, dbMax: -20, wfFloor: -100 });
  const [showDisplay, setShowDisplay] = useState(false);
  const [freqText, setFreqText] = useState('5180.000');
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
    (clientRef.current ? clientRef.current.request(cmd, args) : Promise.reject(new Error('not connected'))).catch((e: Error) => {
      addBanner(e.message, 'error');
      throw e;
    });

  // socket + display wiring (the effect owns the client and the renderer)
  useEffect(() => {
    let disposed = false;
    const d = new Display(spRef.current!, wfRef.current!);
    display.current = d;
    const ro = new ResizeObserver(() => d.resize());
    ro.observe(spRef.current!);
    ro.observe(wfRef.current!);
    d.resize();
    let autoPending = loadPrefs().scale === null; // fit the scale once per Start unless the user set one
    let wasOpen = false;
    let lastRx: RxSettings | null = null;
    let lastPaths = 'a';
    let client: Client | null = null;
    d.onRetune = (f) => {
      if (live.current.recording) {
        addBanner(LOCKED);
        return;
      }
      clientRef.current?.request('set', { freq: snap(f) }).catch((e: Error) => addBanner(e.message, 'error'));
      updatePrefs({ retuned: true });
    };
    Client.fromLocation()
      .then((c) => {
        if (disposed) return;
        client = c;
        clientRef.current = c;
        c.onRow = (r) => {
          d.push(r);
          if (autoPending && d.rowsSeen() > 25) {
            autoPending = false;
            const s = d.suggestRange();
            if (s) setScale(s);
          }
        };
        c.onConnection = (up) => setConnected(up);
        c.onGiveUp = (why) => setFatal(why);
        c.onEvent = (e) => {
          switch (e.type) {
            case 'devices':
              setDevices(e.devices);
              setSelKey((k) => (k !== null && e.devices.some((x: Device) => devKey(x) === k) ? k : e.devices[0] ? devKey(e.devices[0]) : null));
              break;
            case 'caps':
              if (e.open && !wasOpen) {
                d.newStream();
                autoPending = loadPrefs().scale === null;
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
                if (lastRx && (lastRx.freq !== e.rx.freq || lastRx.rate_sel !== e.rx.rate_sel)) setSaved(null);
                lastRx = e.rx;
                setRx(e.rx);
                lastSentFreq.current = null;
                if (!freqFocused.current) setFreqText(mhz(e.rx.freq, 3));
                setGainUi(null);
              }
              if (e.dsp) {
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
                if (cl > dr.client) w.push('display skipped rows (browser too slow)');
              }
              if (w.length || e.t - dr.at >= 5) setDropWarn(w);
              dr.ring = ring;
              dr.client = cl;
              break;
            }
            case 'recorded':
              setSaved({ file: e.file, bytes: e.bytes, seconds: e.seconds, reason: e.reason, error: e.error, dropped: e.dropped });
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
  const locked = open && recording; // tuning/gain locked while recording (a change would end the file)
  const fsNow = 80e6 / (1 << cur.rate_sel);
  const width = cur.rate_sel === 1 && (caps.wide_capable ?? true) ? 40 : 20;
  const chan = channelAt(cur.freq, width);
  const rates = caps.rates ?? (sel && sel.max_msps < 40 ? RATES.filter((r) => r.fs <= 5e6) : RATES);
  const tuned = status?.rx?.centre ?? 0;
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
              ? 'Stopped. Last picture shown. Press ▶ Start to resume.'
              : 'Stopped. Press ▶ Start to begin.';
  useEffect(
    () =>
      display.current?.setOpts({
        ...scale, wfMode: prefs.wfMode, smooth: prefs.smooth, overlay, dim: !open,
        wfPath: dsp.paths === 'b' ? 1 : 0, marker: open ? cur.freq : null,
      }),
    [scale, prefs.wfMode, prefs.smooth, overlay, open, dsp.paths, cur.freq],
  );

  // A settings change: sent now when streaming, kept as a draft until Start otherwise.
  const set = (args: Partial<RxSettings>) => {
    if (!live.current.open) {
      setDraft((dr) => ({ ...dr, ...args }));
      if (args.freq !== undefined) setFreqText(mhz(args.freq, 3));
      return;
    }
    req('set', args).catch(() => {});
  };
  const doStart = async () => {
    if (!sel) return;
    setStarting(true);
    setSaved(null);
    try {
      await req('open', { pid: sel.pid, bus: sel.bus, port: sel.port, ...draft });
    } catch {
      /* shown */
    } finally {
      setStarting(false);
    }
  };
  const pickChannel = (key: string) => {
    const c = CHANNELS.find((x) => channelKey(x) === key);
    if (!c) return;
    if (c.width === 40 && (caps.wide_capable ?? sel?.max_msps === 40)) set({ freq: c.centre, rate_sel: 1, wide: true });
    else set({ freq: c.centre });
  };
  const commitFreq = () => {
    const f = Math.round(parseFloat(freqText) * 1e6);
    if (!Number.isFinite(f) || f < 2.3e9 || f > 6.2e9) {
      setFreqText(mhz(cur.freq, 3));
      if (freqText.trim()) addBanner('Frequency must be between 2300 and 6200 MHz', 'error');
      return;
    }
    if (f === lastSentFreq.current || Math.abs(f - cur.freq) < 1) return; // Enter then blur: send once
    lastSentFreq.current = f;
    set({ freq: f });
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
    if (rxState === 'streaming' && st.fs && msps > 0 && msps < 0.95 * (st.fs / 1e6)) warn.push(`input ${msps.toFixed(2)} MS/s`);
  }
  const dotClass = fatal || !connected ? 'dot bad' : opening ? 'dot warn' : !open ? 'dot' : rxState === 'streaming' ? 'dot ok' : 'dot bad';
  const stateText = fatal ? 'disconnected' : !connected ? 'connecting…' : opening ? 'starting…' : open ? rxState : 'stopped';
  const recRate = fsNow * 4; // bytes/s (int16 I + Q)

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
            <button className="stop" onClick={() => req('close').catch(() => {})}>
              ■ Stop
            </button>
          )}
          {open ? (
            <button
              className={recording ? 'rec on' : 'rec'}
              disabled={rxState !== 'streaming'}
              onClick={toggleRecord}
              title={`Record raw IQ (SigMF), about ${bytes(recRate)}/s at this span`}
            >
              {recording ? '■ Stop recording' : '● Record'}
            </button>
          ) : (
            <button disabled={opening || !connected} onClick={() => req('scan').catch(() => {})} title="Look for adapters again">
              ⟳ Rescan
            </button>
          )}
        </div>

        <div className="group" title={locked ? LOCKED : undefined}>
          <label htmlFor="ch">Channel</label>
          <select id="ch" disabled={locked} value={chan ? channelKey(chan) : ''} onChange={(e) => pickChannel(e.target.value)}>
            <option value="" disabled>
              custom
            </option>
            <optgroup label="2.4 GHz">
              {CHANNELS.filter((c) => c.band === '2.4').map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
              ))}
            </optgroup>
            <optgroup label="5 GHz · 20 MHz">
              {CHANNELS.filter((c) => c.band === '5' && c.width === 20).map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
              ))}
            </optgroup>
            <optgroup label="5 GHz · 40 MHz">
              {CHANNELS.filter((c) => c.width === 40).map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
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
          <label htmlFor="span">Span</label>
          <select id="span" disabled={locked} value={cur.rate_sel} onChange={(e) => set({ rate_sel: Number(e.target.value), wide: true })} title="Bandwidth shown (= sample rate)">
            {rates.map((r) => (
              <option key={r.rate_sel} value={r.rate_sel}>
                {spanLabel(r.fs)}
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
            title="Fit the scale to the signal (noise floor to strongest peak) and refit after each Start"
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
                      <option key={n} value={n}>
                        {n} ({(fsNow / Math.min(n, 4096) / 1e3).toFixed(1)} kHz/bin)
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
                  <select value={prefs.wfMode} onChange={(e) => updatePrefs({ wfMode: e.target.value as 'max' | 'avg' })}>
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
          <span className="muted">tuning locked</span>
          {status.record.dropped > 0 && <span className="warn">{status.record.dropped} samples dropped (disk too slow)</span>}
        </div>
      )}
      {!recording && saved && (
        <div className={saved.error ? 'strip error' : 'strip'}>
          <span>
            {saved.error ? `Recording stopped: ${saved.error}. ` : saved.reason ? `Recording stopped (${saved.reason}). ` : ''}
            Saved <code title={saved.file}>{baseName(saved.file)}</code> · {bytes(saved.bytes)} · {saved.seconds.toFixed(1)} s
            {saved.dropped ? ` · ${saved.dropped} samples dropped` : ''}
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
      {banners.map((b) => (
        <div key={b.id} className={b.kind === 'error' ? 'strip error' : 'strip'}>
          {b.text}
          <button className="x" onClick={() => dropBanner(b.id)} title="Dismiss">
            ×
          </button>
        </div>
      ))}

      <main className="plots">
        <canvas ref={spRef} className="spectrum" />
        <canvas ref={wfRef} className="waterfall" />
      </main>

      <footer className="status">
        <span className={dotClass} />
        <span>{stateText}</span>
        {open && st && (
          <span>
            {chan && !offGrid ? `ch ${chan.label} · ` : ''}
            {offGrid ? `${mhz(cur.freq)} MHz requested · tuned ${mhz(tuned)} (5 MHz steps)` : `${mhz(cur.freq)} MHz`} · {spanLabel(st.fs)} span
          </span>
        )}
        {warn.map((w) => (
          <span key={w} className="warn">
            {w}
          </span>
        ))}
        {status?.rx?.error && <span className="warn">{status.rx.error}</span>}
        {!open && status?.error && <span className="warn">{status.error}</span>}
        {!prefs.retuned && open && <span className="hint">tip: double-click the plot to tune there</span>}
      </footer>
    </div>
  );
}
