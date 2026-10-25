// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState } from 'react';
import { CHANNELS, channelAt } from './channels';
import { Display } from './display';
import { Client, type Caps, type Device, type DspSettings, type RxSettings, type Status } from './protocol';

const FFTS = [1024, 2048, 4096, 8192, 16384];
const fmtRate = (fs: number) => `${fs / 1e6} MS/s`;

function deviceLabel(d: Device) {
  const usb = d.speed_mbps >= 5000 ? 'USB 3' : 'USB 2';
  return `${d.model} · ${usb} · bus ${d.bus} port ${d.port}${d.controller ? ` · ${d.controller.replace(/^0000:/, '')}` : ''}`;
}

export default function App() {
  const clientRef = useRef<Client | null>(null);
  const spRef = useRef<HTMLCanvasElement>(null);
  const wfRef = useRef<HTMLCanvasElement>(null);
  const display = useRef<Display | null>(null);
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selPid, setSelPid] = useState<number | null>(null);
  const [caps, setCaps] = useState<Caps>({ open: false });
  const [rx, setRx] = useState<RxSettings | null>(null);
  const [dsp, setDsp] = useState<DspSettings>({ fft: 8192, rows_per_s: 25, paths: 'a', dc_remove: true });
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState({ dbMin: -110, dbMax: -20 });
  const [wfMode, setWfMode] = useState<'max' | 'avg'>('max');
  const [smooth, setSmooth] = useState(0.7);
  const [freqText, setFreqText] = useState('');
  const [gainUi, setGainUi] = useState<number | null>(null);
  const gainTimer = useRef<number | undefined>(undefined);
  const rate = useRef({ banks: 0, t: 0 });
  const [msps, setMsps] = useState(0);

  const notify = (text: string, error = false) => {
    setMessage({ text, error });
    if (!error) window.setTimeout(() => setMessage((m) => (m && m.text === text ? null : m)), 4000);
  };
  const req = (cmd: string, args: Record<string, unknown> = {}) =>
    (clientRef.current ? clientRef.current.request(cmd, args) : Promise.reject(new Error('not connected'))).catch((e: Error) => {
      notify(e.message, true);
      throw e;
    });

  // socket + display wiring
  useEffect(() => {
    const client = Client.fromLocation();
    clientRef.current = client;
    const d = new Display(spRef.current!, wfRef.current!);
    display.current = d;
    d.onRetune = (f) => client.request('set', { freq: f }).catch((e: Error) => notify(e.message, true));
    const ro = new ResizeObserver(() => d.resize());
    ro.observe(spRef.current!);
    ro.observe(wfRef.current!);
    d.resize();
    let autoPending = true; // fit the range once, a second after rows start (and after each Start)
    client.onRow = (r) => {
      d.push(r);
      if (autoPending && d.rowsSeen() > 25) {
        autoPending = false;
        const s = d.suggestRange();
        if (s) setRange(s);
      }
    };
    client.onConnection = (up) => setConnected(up);
    client.onEvent = (e) => {
      switch (e.type) {
        case 'devices':
          setDevices(e.devices);
          setSelPid((p) => (p !== null && e.devices.some((x: Device) => x.pid === p) ? p : e.devices[0]?.pid ?? null));
          break;
        case 'caps':
          setCaps(e);
          d.clear();
          autoPending = true;
          break;
        case 'settings':
          if (e.rx) {
            setRx(e.rx);
            setFreqText((e.rx.freq / 1e6).toFixed(3));
          }
          if (e.dsp) setDsp(e.dsp);
          break;
        case 'status': {
          setStatus(e);
          const banks = e.rx?.banks ?? 0;
          const r = rate.current;
          if (r.t && e.t > r.t && banks >= r.banks) setMsps(((banks - r.banks) * 8192) / (e.t - r.t) / 1e6);
          r.banks = banks;
          r.t = e.t;
          break;
        }
        case 'notice':
          notify(e.msg);
          break;
        case 'error':
          notify(e.msg ?? 'error', true);
          break;
      }
    };
    client.connect();
    return () => {
      ro.disconnect();
      d.destroy();
      client.close();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => display.current?.setOpts({ ...range, wfMode, smooth, wfPath: dsp.paths === 'b' ? 1 : 0 }), [range, wfMode, smooth, dsp.paths]);

  const open = caps.open;
  const opening = status?.state === 'opening';
  const sel = devices.find((d) => d.pid === selPid);
  const width = rx && caps.wide_capable && rx.rate_sel === 1 && rx.wide ? 40 : 20;
  const chan = rx ? channelAt(rx.freq, width) : undefined;

  const doOpen = async () => {
    if (selPid === null) return;
    setBusy(true);
    try {
      await req('open', { pid: selPid });
    } catch {
      /* shown */
    } finally {
      setBusy(false);
    }
  };
  const doClose = () => req('close').catch(() => {});
  const set = (args: Partial<RxSettings>) => req('set', args).catch(() => {});
  const setDspArgs = (args: Partial<DspSettings>) => req('dsp', args).catch(() => {});
  const pickChannel = (key: string) => {
    const c = CHANNELS.find((x) => `${x.band}:${x.width}:${x.ch}` === key);
    if (!c || !rx) return;
    if (c.width === 40 && caps.wide_capable) set({ freq: c.centre, rate_sel: 1, wide: true });
    else set({ freq: c.centre });
  };
  const commitFreq = () => {
    const f = parseFloat(freqText) * 1e6;
    if (Number.isFinite(f) && rx && Math.abs(f - rx.freq) > 1) set({ freq: f });
  };
  const onGain = (v: number) => {
    setGainUi(v);
    window.clearTimeout(gainTimer.current);
    gainTimer.current = window.setTimeout(() => {
      set({ gain_db: v });
      setGainUi(null);
    }, 200);
  };
  const recording = status?.record.active ?? false;
  const toggleRecord = async () => {
    try {
      const r = await req('record', { action: recording ? 'stop' : 'start' });
      if (r.file) notify(recording ? `saved ${r.file}` : `recording to ${r.file}`);
    } catch {
      /* shown */
    }
  };

  const rxState = status?.rx?.state ?? status?.state ?? 'closed';
  const stateText = !connected ? 'disconnected' : opening ? 'starting adapter (~5 s)…' : open ? rxState : 'no adapter open';

  return (
    <div className="app">
      <header className="bar">
        <div className="group">
          <span className="brand">wsdr-studio</span>
          <select
            value={selPid ?? ''}
            disabled={open || opening || !devices.length}
            onChange={(e) => setSelPid(Number(e.target.value))}
            title="Adapter"
          >
            {!devices.length && <option value="">no adapter found</option>}
            {devices.map((d) => (
              <option key={`${d.bus}-${d.port}`} value={d.pid}>
                {deviceLabel(d)}
              </option>
            ))}
          </select>
          {!open ? (
            <button className="primary" disabled={!sel || busy || opening || !connected || !sel.can_open} onClick={doOpen}>
              {busy || opening ? 'Starting…' : 'Start'}
            </button>
          ) : (
            <button onClick={doClose}>Stop</button>
          )}
          <button disabled={open || opening || !connected} onClick={() => req('scan').catch(() => {})} title="Rescan USB">
            ⟳
          </button>
        </div>

        <div className="group">
          <label>Channel</label>
          <select disabled={!open} value={chan ? `${chan.band}:${chan.width}:${chan.ch}` : ''} onChange={(e) => pickChannel(e.target.value)}>
            <option value="">{chan ? '' : 'custom'}</option>
            <optgroup label="2.4 GHz">
              {CHANNELS.filter((c) => c.band === '2.4').map((c) => (
                <option key={`2:${c.ch}`} value={`${c.band}:${c.width}:${c.ch}`}>{`ch ${c.label} · ${c.centre / 1e6}`}</option>
              ))}
            </optgroup>
            <optgroup label="5 GHz · 20 MHz">
              {CHANNELS.filter((c) => c.band === '5' && c.width === 20).map((c) => (
                <option key={`5:20:${c.ch}`} value={`${c.band}:${c.width}:${c.ch}`}>{`ch ${c.label} · ${c.centre / 1e6}`}</option>
              ))}
            </optgroup>
            <optgroup label="5 GHz · 40 MHz">
              {CHANNELS.filter((c) => c.width === 40).map((c) => (
                <option key={`5:40:${c.ch}`} value={`${c.band}:${c.width}:${c.ch}`}>{`ch ${c.label} · ${c.centre / 1e6}`}</option>
              ))}
            </optgroup>
          </select>
          <input
            className="freq"
            disabled={!open}
            value={freqText}
            onChange={(e) => setFreqText(e.target.value)}
            onBlur={commitFreq}
            onKeyDown={(e) => e.key === 'Enter' && commitFreq()}
            title="Centre frequency (MHz)"
          />
          <span className="unit">MHz</span>
        </div>

        <div className="group">
          <label>Rate</label>
          <select disabled={!open} value={rx?.rate_sel ?? ''} onChange={(e) => set({ rate_sel: Number(e.target.value) })}>
            {(caps.rates ?? []).map((r) => (
              <option key={r.rate_sel} value={r.rate_sel}>
                {fmtRate(r.fs)}
              </option>
            ))}
          </select>
          {caps.wide_capable && rx?.rate_sel === 1 && (
            <label className="check" title="40 MHz channel width + 40 MHz receive filter (full ±20 MHz)">
              <input type="checkbox" checked={rx.wide} onChange={(e) => set({ wide: e.target.checked })} />
              40 MHz
            </label>
          )}
        </div>

        <div className="group">
          <label>Gain</label>
          <input
            type="range"
            disabled={!open || rx?.agc}
            min={0}
            max={caps.gain_max ?? 49}
            step={caps.gain_step ?? 1}
            value={gainUi ?? rx?.gain_db ?? 30}
            onChange={(e) => onGain(Number(e.target.value))}
          />
          <span className="val">{rx?.agc ? 'AGC' : `${(gainUi ?? rx?.gain_db ?? 30).toFixed(0)} dB`}</span>
          <label className="check">
            <input type="checkbox" disabled={!open} checked={rx?.agc ?? false} onChange={(e) => set({ agc: e.target.checked })} />
            AGC
          </label>
        </div>

        {caps.paths === 2 && (
          <div className="group">
            <label>Antenna</label>
            {(['a', 'b', 'ab'] as const).map((p) => (
              <button key={p} className={dsp.paths === p ? 'on' : ''} onClick={() => setDspArgs({ paths: p })}>
                {p === 'ab' ? 'A+B' : p.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        <div className="group">
          <label>FFT</label>
          <select value={dsp.fft} onChange={(e) => setDspArgs({ fft: Number(e.target.value) })}>
            {FFTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <label>Range</label>
          <input className="num" type="number" value={range.dbMin} step={5} onChange={(e) => setRange((r) => ({ ...r, dbMin: Number(e.target.value) }))} />
          <input className="num" type="number" value={range.dbMax} step={5} onChange={(e) => setRange((r) => ({ ...r, dbMax: Number(e.target.value) }))} />
          <button
            title="Fit the range to the signal: noise floor to strongest peak"
            onClick={() => {
              const s = display.current?.suggestRange();
              if (s) setRange(s);
            }}
          >
            Auto
          </button>
          <label>Smooth</label>
          <select value={smooth} onChange={(e) => setSmooth(Number(e.target.value))} title="Averaging of the spectrum trace over time (like gqrx)">
            <option value={0}>off</option>
            <option value={0.5}>low</option>
            <option value={0.7}>medium</option>
            <option value={0.9}>high</option>
          </select>
          <select value={wfMode} onChange={(e) => setWfMode(e.target.value as 'max' | 'avg')} title="Waterfall shows the peak or the average of each row">
            <option value="max">peak</option>
            <option value="avg">avg</option>
          </select>
        </div>

        <div className="group right">
          <button className={recording ? 'rec on' : 'rec'} disabled={!open || rxState !== 'streaming'} onClick={toggleRecord}>
            {recording ? `■ ${status!.record.seconds.toFixed(1)} s` : '● Record'}
          </button>
        </div>
      </header>

      {sel && !sel.can_open && !open && (
        <div className="banner error">
          No permission to open {sel.model} (bus {sel.bus} port {sel.port}). Install the udev rule once:{' '}
          <code>sudo cp tools/99-wsdr.rules /etc/udev/rules.d/ &amp;&amp; sudo udevadm control --reload</code> (from wifi-sdr), then replug.
        </div>
      )}
      {sel && sel.driver && !open && (
        <div className="banner">
          The kernel driver <code>{sel.driver}</code> holds this adapter; Start takes it over.
        </div>
      )}
      {sel && sel.pid === 0xb812 && sel.speed_mbps < 5000 && !open && (
        <div className="banner">This 8812BU is on USB 2: 2.5 and 5 MS/s only. 40 MS/s needs it on USB 3.</div>
      )}
      {message && (
        <div className={message.error ? 'banner error' : 'banner'} onClick={() => setMessage(null)}>
          {message.text}
        </div>
      )}

      <main className="plots">
        <canvas ref={spRef} className="spectrum" />
        <canvas ref={wfRef} className="waterfall" />
      </main>

      <footer className="status">
        <span className={connected ? 'dot ok' : 'dot'} />
        <span>{stateText}</span>
        {open && status?.rx && (
          <>
            <span>{caps.adapter}</span>
            <span>
              ch {status.rx.channel} · {status.rx.width} MHz · {(status.rx.centre / 1e6).toFixed(1)} MHz
            </span>
            <span>{msps.toFixed(2)} MS/s in</span>
            <span>restarts {status.rx.restarts}</span>
            <span>DSP {(status.dsp_load * 100).toFixed(0)} %</span>
            {status.ring_dropped > 0 && <span className="warn">dropped {status.ring_dropped}</span>}
            {status.rx.error && <span className="warn">{status.rx.error}</span>}
          </>
        )}
        {status?.error && !open && <span className="warn">{status.error}</span>}
        <span className="hint">double-click the plot to retune</span>
      </footer>
    </div>
  );
}
