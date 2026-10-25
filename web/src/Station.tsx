// SPDX-License-Identifier: GPL-2.0-only
// One adapter's view (slot 0 = A, 1 = B): its header (frequency, Start/Stop, Record), its spectrum and
// waterfall, and, while it is the selected view, its sidebar sections (adapter, tuning, gain).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CHANNELS, channelAt, channelKey } from './channels';
import { Display, type Source } from './display';
import type { Hub } from './hub';
import type { Caps, Device, DspSettings, Rate, RxSettings, Row, Status } from './protocol';
import { Section, Seg } from './ui';
import {
  ANT_COLOUR, LOCKED, SLOT_NAME, UDEV_CMD, VIEW_COLOUR, bandOf, baseName, bytes, chanShort, devKey, devLabel, devTitle, fmtClock,
  fmtDur, gappedDuty, loadPrefs, mhz, ratesFor, snap, spanLabel, type Mode, type Prefs, type Scale, type Tuning,
} from './util';

type Banner = { id: number; text: string; kind: 'info' | 'error' };
type Saved = { file: string; bytes: number; seconds: number; reason?: string; error?: string };

// What the views share (display preferences, the scale) and how a view reaches the other (locks).
export type Shared = { prefs: Prefs; updatePrefs: (p: Partial<Prefs>) => void; scale: Scale; setScale: (s: Scale) => void };
export type StationHandle = {
  linkedSet: (args: Partial<RxSettings>) => void; // a change from the other view (no further forwarding)
  tune: (f: number) => void;                      // a user tune (the band ruler, keys): forwarded like one made here
  req: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  freq: () => number;
  rateOk: (rate_sel: number) => boolean;          // a continuous span on this adapter (a lock never makes one gapped)
  fs: () => number;                               // the span it shows (Hz)
  suggest: (wfMode?: 'max' | 'avg') => Scale | null; // Auto scale from this view's picture
  busy: () => string | null; // why a linked change must not touch this view now (recording, starting)
  notice: (text: string) => void;
  // keyboard shortcuts
  toggleRun: () => void;
  toggleRec: () => void;
  spanStep: (dir: 1 | -1) => void;   // the next wider / narrower continuous span
  typeFreq: (digit: string) => void; // start typing a frequency in this view's header
};
// What a view tells the shell (sidebar summary, links, band ruler).
export type ViewInfo = {
  freq: number; fsNow: number; rate_sel: number; fft: number; gapped: boolean; gain_db: number; agc: boolean;
  centre: number; // where the shown span is centred (the radio's centre while running, else the request)
  src: Source;    // its part of the stitched Panorama plot
  open: boolean; recording: boolean; locked: boolean; selKey: string | null;
};
export type Link = {
  userSet: (slot: number, args: Partial<RxSettings>) => void;  // a user change: locked fields go to the other view
  register: (slot: number, h: StationHandle | null) => void;
  report: (slot: number, v: ViewInfo) => void;
  autoFit: () => void;                                         // refit the shared scale (both views' pictures)
  survey: (r: Row) => void;                                    // the band ruler's per-channel survey
};

export function Station(p: {
  slot: number; mode: Mode; hub: Hub; shared: Shared; link: Link; selected: boolean; onSelect: () => void;
  sidebar: HTMLElement | null; linksBox: ReactNode;
  otherSel: string | null; otherOpen: string | null; // the other view's adapter (picked, open)
}) {
  const { slot, mode, hub, shared, link, selected } = p;
  const dual = mode !== 'single';
  const name = SLOT_NAME[slot];
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
  // for callbacks that outlive a render; want: a frequency sent and not yet acknowledged (a link reads it,
  // so quick changes in a row keep the views' distance)
  // rates: the open adapter's (caps), set as events arrive, so a handle used in the same commit is current
  const live = useRef({
    open: false, recording: false, opening: false, freq: 5180e6, rateSel: 4, want: null as number | null, wantId: 0, rates: null as Rate[] | null,
  });
  const autoOn = useRef(loadPrefs().scale === null); // Auto scale on (mirrors prefs.scale === null; storage may be blocked)
  const view = useRef({ ghost: false, other: p.otherSel }); // for the socket callbacks
  const [home, setHome] = useState('');
  const setRef = useRef<(a: Partial<RxSettings>) => void>(() => {});

  const { prefs, updatePrefs, scale } = shared;
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
  // unplugged while running: the adapter (pid, picker key) to start again when it is back
  const [lost, setLost] = useState<{ pid: number; key: string } | null>(null);
  const freqInput = useRef<HTMLInputElement>(null);

  const rememberTuning = (t: Tuning) => updatePrefs(slot ? { tuningB: t } : { tuning: t });
  const addBanner = (text: string, kind: Banner['kind'] = 'info') => {
    const id = bannerId.current++;
    setBanners((b) => [...b.filter((x) => x.text !== text), { id, text, kind }]);
    if (kind === 'info') window.setTimeout(() => setBanners((b) => b.filter((x) => x.id !== id)), 6000);
  };
  const dropBanner = (id: number) => setBanners((b) => b.filter((x) => x.id !== id));
  const req = (cmd: string, args: Record<string, unknown> = {}) =>
    hub.request(cmd, { ...args, slot }).catch((e: Error & { kind?: string }) => {
      addBanner(e.message, e.kind === 'busy' ? 'info' : 'error'); // "try again in a moment" is not a fault
      throw e;
    });

  // socket + display wiring (the effect owns the renderer and the subscription)
  useEffect(() => {
    const d = new Display(spRef.current!, wfRef.current!);
    display.current = d;
    const ro = new ResizeObserver(() => d.resize());
    ro.observe(spRef.current!);
    ro.observe(wfRef.current!);
    d.resize();
    // Auto refit: after Start; after an rx change once 25 rows of the NEW run arrived (rows of the old
    // run may still be in flight); after a display change (FFT) once 25 more rows arrived.
    // autoAt = the row count to refit at (-1: nothing pending); autoRun = the run count to wait for.
    let autoAt = autoOn.current ? 25 : -1;
    let autoRun = -1;
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
    let opened: { pid: number; key: string } | null = null; // the adapter of the current run
    let lastRx: RxSettings | null = null;
    let lastPaths = 'a';
    let lastFft = 0;
    d.onRetune = (f) => {
      if (live.current.recording || live.current.opening) {
        if (live.current.recording) addBanner(LOCKED);
        return;
      }
      const t = snap(f); // the request stays; at a 40 MHz span the radio centres as near as it can
      if (Math.abs(t - live.current.freq) < 1) addBanner(`Already at the nearest step (${mhz(t, 0)} MHz). The radio tunes in 5 MHz steps.`);
      else setRef.current({ freq: t }); // live retune, or the draft for the next Start when stopped
      updatePrefs({ retuned: true });
    };
    const unsubscribe = hub.subscribe({
      slot,
      row: (r) => {
        d.push(r);
        if (r.seq % 5 === 0) link.survey(r);
        const runDone = autoRun >= 0 && d.runCount() >= autoRun && d.runRows() >= 25;
        const rowsDone = autoAt >= 0 && d.rowsSeen() >= autoAt;
        if (runDone || rowsDone) {
          if (runDone) autoRun = -1; // clear only the trigger that fired
          if (rowsDone) autoAt = -1;
          if (autoOn.current) link.autoFit(); // unless the user fixed a scale meanwhile
        }
      },
      other: (r) => view.current.ghost && d.setGhost(r),
      connection: (up) => {
        setConnected(up);
        if (!up) wasOpen = false; // the radio may be stopped and restarted elsewhere meanwhile: the next caps is a fresh Start
      },
      giveUp: (why) => setFatal(why),
      event: (e) => {
        switch (e.type) {
          case 'devices': {
            setDevices(e.devices);
            // keep the pick; else the first adapter the other view has not picked (nothing picked yet,
            // at a start in a two-view mode: B takes the second)
            const other = view.current.other;
            const free = other !== null ? e.devices.find((x: Device) => devKey(x) !== other) ?? e.devices[0] : e.devices[slot] ?? e.devices[0];
            setSelKey((k) => (k !== null && e.devices.some((x: Device) => devKey(x) === k) ? k : free ? devKey(free) : null));
            break;
          }
          case 'caps':
            // the picker shows the adapter that is open, whoever opened it
            if (e.open && e.bus !== undefined && e.bus >= 0) {
              setSelKey(`${e.bus}-${e.port}`);
              opened = { pid: e.pid, key: `${e.bus}-${e.port}` };
              setLost(null);
            }
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
            live.current.rates = e.open ? e.rates ?? null : null;
            setCaps(e);
            break;
          case 'settings':
            if (e.rx) {
              if (lastRx && (lastRx.freq !== e.rx.freq || lastRx.rate_sel !== e.rx.rate_sel || lastRx.gain_db !== e.rx.gain_db || lastRx.agc !== e.rx.agc))
                autoAgain(true);
              if (lastRx && lastRx.freq !== e.rx.freq) updatePrefs({ retuned: true });
              rememberTuning({ freq: e.rx.freq, rate_sel: e.rx.rate_sel, gain_db: e.rx.gain_db, agc: e.rx.agc });
              lastRx = e.rx;
              live.current.freq = e.rx.freq;
              live.current.rateSel = e.rx.rate_sel;
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
            live.current.opening = e.state === 'opening';
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
            if (e.kind === 'lost' && opened) setLost(opened); // the header says it; no banner
            else addBanner(e.msg, 'error');
            break;
          case 'error':
            addBanner(e.msg ?? 'error', 'error');
            break;
        }
      },
    });
    return () => {
      unsubscribe();
      ro.disconnect();
      d.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A remembered 40 MHz tuning on an adapter that cannot do it (USB 2, 8812CU): clamp the draft.
  const sel = devices.find((d) => devKey(d) === selKey);
  const selMax = sel?.max_msps ?? 40; // continuous: a remembered wide span never opens gapped by itself
  useEffect(() => {
    if (selMax < 40) setDraft((dr) => (dr.rate_sel < 4 ? { ...dr, rate_sel: 4 } : dr)); // every 40 MHz centre is also a 5 MHz step
  }, [selMax]);

  const open = caps.open;
  const opening = status?.state === 'opening' || starting;
  const cur = rx ?? draft; // what the controls show
  const rxState = open ? status?.rx?.state ?? 'starting' : 'stopped';
  const recording = status?.record.active ?? false;
  const locked = (open && recording) || opening; // recording: a change would end the file; opening: it would be lost

  const fsNow = 80e6 / (1 << cur.rate_sel);
  const chan = channelAt(cur.freq, 20); // by centre frequency only (the span does not pick a channel)
  const rates: Rate[] = caps.rates ?? ratesFor(sel, prefs.offsetTuning);
  // the selected span (follows a change at once; the badge shows the run's measured share)
  const gapped = rates.find((r) => r.rate_sel === cur.rate_sel)?.gapped ?? false;
  const run = status?.rx;
  const hwFs = run?.hw_fs ?? run?.fs ?? 0;
  const gappedPct = run?.gapped && msps > 0 && hwFs ? Math.round(((msps * 1e6) / hwFs) * 100) : null;
  const tuned = run?.centre ?? 0;
  const chip = caps.chip ?? sel?.chip ?? '';
  const twoPaths = (caps.paths ?? 1) === 2;
  const ghost = mode === 'compare' && prefs.ghost; // the other view's average over this one
  useEffect(() => {
    live.current.opening = opening;
    live.current.freq = cur.freq;
    live.current.rateSel = cur.rate_sel;
  }, [opening, cur.freq, cur.rate_sel]);
  // stopped on an adapter the other view has just opened: take a free one
  useEffect(() => {
    if (open || opening || !p.otherOpen || selKey !== p.otherOpen) return;
    const free = devices.find((d) => devKey(d) !== p.otherOpen);
    if (free) setSelKey(devKey(free));
  }, [p.otherOpen, selKey, open, opening, devices]);
  useEffect(() => () => window.clearTimeout(gainTimer.current), []); // a gain change still waiting dies with the view
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
          : !devices.length || lost || (sel && !sel.can_open)
            ? null // a card says it
            : hadPicture
              ? 'Stopped. Double-click the spectrum to pick a frequency; ▶ Start to resume.'
              : 'Stopped. Press ▶ Start to begin.';
  const marker = open || hadPicture ? cur.freq : null;
  const markerLabel = open ? 'requested' : 'next Start';
  const chipNotch = chip.includes('8822C');
  // the 8822B dips at its centre at 40 MHz on 2.4 GHz (measured: ~8-10 dB over +-1 MHz)
  const notchWide = open && (caps.chip ?? '').includes('8822B') && hwFs >= 40e6 && tuned > 0 && tuned < 3.7e9;
  useEffect(
    () =>
      display.current?.setOpts({
        ...scale, wfMode: prefs.wfMode, smooth: prefs.smooth, overlay, dim: !open,
        wfPath: dsp.paths === 'b' ? 1 : 0, marker, markerLabel, chipNotch, notchWide,
        colour: VIEW_COLOUR[slot], pathColours: twoPaths ? ANT_COLOUR : null, ghostColour: VIEW_COLOUR[slot ^ 1],
        showAvg: prefs.showAvg, showPeak: prefs.showPeak,
        staleText: rxState === 'starting' ? 'Applying settings…' : 'No data from the adapter',
      }),
    [scale, prefs.wfMode, prefs.smooth, prefs.showAvg, prefs.showPeak, overlay, open, dsp.paths, marker, markerLabel, chipNotch, notchWide, rxState, slot, twoPaths],
  );

  // A settings change: sent now when streaming, kept as a draft until Start otherwise.
  const set = (args: Partial<RxSettings>) => {
    if (!live.current.open) {
      const n = { ...draft, ...args };
      live.current.freq = n.freq;
      live.current.rateSel = n.rate_sel;
      setDraft(n);
      rememberTuning({ freq: n.freq, rate_sel: n.rate_sel, gain_db: n.gain_db, agc: n.agc }); // remembered too
      if (args.freq !== undefined) setFreqText(mhz(args.freq, 3));
      return;
    }
    if (args.freq === undefined) {
      req('set', args).catch(() => {});
      return;
    }
    const id = ++live.current.wantId;
    live.current.want = args.freq;
    req('set', args)
      .catch(() => {})
      .finally(() => id === live.current.wantId && (live.current.want = null));
  };
  // A change the user made here: offered to the other view (it takes the linked fields; first, while
  // this view's frequency is still the old one, so the distance is kept), then applied.
  const userSet = (args: Partial<RxSettings>) => {
    link.userSet(slot, args);
    set(args);
  };
  const tuneTo = (f: number) => { // the ‹ › buttons, the ruler: same snapping as a typed frequency
    if (locked) return;
    const t = snap(f);
    setFreqText(mhz(t, 3));
    if (Math.abs(t - cur.freq) < 1) return;
    lastSentFreq.current = t;
    updatePrefs({ retuned: true });
    userSet({ freq: t });
  };
  useEffect(() => {
    setRef.current = userSet;
    view.current = { ghost, other: p.otherSel };
    if (!ghost) display.current?.setGhost(null);
    link.register(slot, {
      linkedSet: set, tune: tuneTo, req, freq: () => live.current.want ?? live.current.freq,
      rateOk: (r) => (live.current.rates ?? rates).some((x) => x.rate_sel === r && !x.gapped),
      fs: () => 80e6 / (1 << live.current.rateSel),
      suggest: (wfMode) => {
        if (wfMode) display.current?.setOpts({ wfMode });
        return display.current?.suggestRange() ?? null;
      },
      busy: () => (live.current.recording ? 'it is recording' : live.current.opening || starting ? 'it is starting' : null),
      notice: (text) => addBanner(text),
      toggleRun: () => {
        if (open) req('close').catch(() => {});
        else if (sel && sel.can_open && !opening && connected) void doStart();
      },
      toggleRec: () => {
        if (recording || (open && rxState === 'streaming' && !gapped && !runGapped)) void toggleRecord();
        else addBanner(gapped || runGapped ? 'Recording needs a continuous span' : 'Recording starts while streaming');
      },
      spanStep: (dir) => {
        if (locked) return addBanner(LOCKED);
        // continuous spans only: a gapped one is picked in the Span list, on purpose
        const ok = rates.filter((r) => !r.gapped).sort((a, b) => a.fs - b.fs);
        const i = ok.findIndex((r) => r.rate_sel === cur.rate_sel);
        const next = ok[i < 0 ? 0 : Math.max(0, Math.min(ok.length - 1, i + dir))];
        if (next && next.rate_sel !== cur.rate_sel) userSet({ rate_sel: next.rate_sel, wide: true });
      },
      typeFreq: (digit) => {
        if (locked) return addBanner(LOCKED);
        if (digit) setFreqText(digit);
        freqInput.current?.focus();
        if (!digit) freqInput.current?.select(); // Enter: the field, its text selected
      },
    });
  });
  useEffect(() => () => link.register(slot, null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const centre = open && tuned > 0 ? tuned : cur.freq;
    const msg = fatal || !connected ? null : opening ? `${name}: starting…` : !open ? `${name} stopped` : rxState === 'starting' ? `${name}: applying settings…` : null;
    link.report(slot, {
      freq: cur.freq, fsNow, rate_sel: cur.rate_sel, fft: dsp.fft, gapped, gain_db: cur.gain_db, agc: cur.agc,
      centre, open, recording, locked, selKey,
      src: { lo: centre - fsNow / 2, hi: centre + fsNow / 2, colour: VIEW_COLOUR[slot], pathColours: twoPaths ? ANT_COLOUR : null, marker, markerLabel, chipNotch, notchWide, dim: !open, msg },
    });
  }, [cur.freq, fsNow, cur.rate_sel, dsp.fft, gapped, cur.gain_db, cur.agc, open, tuned, recording, locked, selKey, marker, markerLabel, chipNotch, notchWide, opening, rxState, fatal, connected, twoPaths]); // eslint-disable-line react-hooks/exhaustive-deps
  // the shared preferences reach this adapter: offset tuning when running, the FFT size at once
  useEffect(() => {
    if (caps.open) req('set', { offset_tuning: prefs.offsetTuning }).catch(() => {});
  }, [prefs.offsetTuning]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (connected && dsp.fft !== prefs.fft) req('dsp', { fft: prefs.fft }).catch(() => {});
  }, [prefs.fft, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const doStart = async (dev = sel) => {
    if (!dev) return;
    setLost(null);
    setStarting(true);
    setSaved(null);
    window.clearTimeout(gainTimer.current); // a gain change still waiting goes with the open
    const gain = gainUi ?? draft.gain_db;
    try {
      await req('open', { pid: dev.pid, bus: dev.bus, port: dev.port, ...draft, gain_db: gain, offset_tuning: prefs.offsetTuning });
    } catch {
      /* shown */
    } finally {
      setStarting(false);
    }
  };
  // Waiting for an adapter (none found, or this one unplugged): look again every 3 s (no hotplug
  // events). An unplugged adapter that is back (the same model; another port is fine) starts again.
  const waiting = connected && !open && !opening && (!devices.length || !!lost);
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => hub.request('scan', { slot }).catch(() => {}), 3000);
    return () => window.clearInterval(t);
  }, [waiting, hub, slot]);
  useEffect(() => {
    if (!lost || open || opening || !connected) return;
    const back = devices.filter((d) => d.pid === lost.pid && d.can_open && devKey(d) !== p.otherOpen);
    const d = back.find((x) => devKey(x) === lost.key) ?? back[0];
    if (!d) return;
    setSelKey(devKey(d));
    void doStart(d);
  }, [devices, lost]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickChannel = (key: string) => {
    const c = CHANNELS.find((x) => channelKey(x) === key);
    if (!c) return;
    updatePrefs({ retuned: true }); // the tip is no longer needed
    // A channel only moves the centre; the width shown is Span alone. Said once per session, and only
    // what this adapter can actually do.
    if (fsNow < c.width * 1e6 - 1 && !narrowNoted.current) {
      narrowNoted.current = true;
      const wider = rates.filter((r) => r.fs >= c.width * 1e6);
      addBanner(
        wider.some((r) => !r.gapped)
          ? `Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel; widen it with Span`
          : wider.length
            ? `Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel; on this adapter wider spans are gapped (Span)`
            : `Showing ${spanLabel(fsNow)} of this ${c.width} MHz channel (the most this adapter shows)`,
      );
    }
    tuneTo(c.centre);
  };
  const pickBand = (b: '2.4' | '5') => b !== bandOf(cur.freq) && tuneTo(b === '2.4' ? 2437e6 : 5180e6);
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
  const setPaths = (paths: string) => paths !== dsp.paths && req('dsp', { paths }).catch(() => {});
  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => addBanner('Copied')).catch(() => {});

  // diagnostics: only when they are abnormal
  const st = status?.rx;
  const warn: string[] = [...dropWarn];
  if (open && st) {
    if (st.restarts > 0) warn.push(`${st.restarts} stream restart${st.restarts > 1 ? 's' : ''}`);
    if (status!.dsp_load > 0.8) warn.push(`DSP ${(status!.dsp_load * 100).toFixed(0)} %`);
    if (rxState === 'streaming' && st.fs && !st.gapped && msps > 0 && msps < 0.95 * (st.fs / 1e6)) warn.push(`input ${msps.toFixed(2)} MS/s`);
  }
  if (st?.error) warn.push(st.error);
  if (!open && status?.error) warn.push(status.error);
  const dotClass =
    fatal || !connected ? 'dot bad'
    : opening || (rxState === 'starting' && !st?.error) ? 'dot warn' // a routine restart (retune, span) is not a fault
    : !open ? 'dot'
    : rxState === 'streaming' ? 'dot ok'
    : 'dot bad';
  const stateText = fatal ? 'disconnected' : !connected ? 'connecting…' : opening ? 'starting…' : open ? rxState : lost ? 'unplugged' : 'stopped';
  const recRate = fsNow * 4; // bytes/s (int16 I + Q)
  const diskFree = status?.disk_free ?? 0;
  const secsLeft = diskFree / recRate;
  const lockTitle = locked ? LOCKED : undefined;
  const band = bandOf(cur.freq);
  const runGapped = !!run?.gapped;
  const recTitle = !recording && gapped
    ? 'Recording needs a continuous span (5 MHz or less on this adapter); gapped spans sample only part of the time'
    : !recording && rxState !== 'streaming'
      ? 'Available while streaming'
      : recording && status
        ? `Recording to ${status.record.file} (${bytes(recRate)}/s${diskFree ? `; ${bytes(diskFree)} free, ~${fmtDur(secsLeft)}` : ''}). Tuning and gain are locked meanwhile.`
        : `Record raw IQ (SigMF), about ${bytes(recRate)}/s at this span${diskFree ? `; ${bytes(diskFree)} free (~${fmtDur(secsLeft)})` : ''}`;

  const sidebar = (
    <>
      <Section id="adapter" title="Adapter" prefs={prefs} updatePrefs={updatePrefs}>
        <select
          aria-label={`Adapter of view ${name}`}
          value={selKey ?? ''}
          disabled={open || opening || !devices.length}
          onChange={(e) => {
            setSelKey(e.target.value);
            setLost(null); // another adapter: no longer waiting for the old one
          }}
          title={sel ? devTitle(sel) : 'Adapter'}
        >
          {!devices.length && <option value="">no adapter found</option>}
          {devices.map((d) => {
            const inOther = devKey(d) === p.otherOpen; // also in Single: view B may still be running
            return (
              <option key={devKey(d)} value={devKey(d)} title={devTitle(d)} disabled={inOther}>
                {devLabel(d)}
                {inOther ? ` (in view ${SLOT_NAME[slot ^ 1]})` : ''}
              </option>
            );
          })}
        </select>
        {!open && (
          <button disabled={opening || !connected} onClick={() => req('scan').catch(() => {})} title="Look for adapters again">
            ⟳ Rescan
          </button>
        )}
        {twoPaths && (
          <div className="field">
            <span>Antennas</span>
            <Seg
              value={dsp.paths}
              disabled={locked}
              options={[['a', 'Ant 1'], ['b', 'Ant 2'], ['ab', 'Both']]}
              onChange={setPaths}
            />
          </div>
        )}
        {sel && sel.driver && sel.driver !== 'usbfs' && !open && (
          <span className="note">The kernel driver <code>{sel.driver}</code> is using this adapter; ▶ Start takes it over.</span>
        )}
        {sel && sel.pid === 0xb812 && sel.speed_mbps < 5000 && !open && (
          <span className="note">Connected at USB 2: ▶ Start switches it to USB 3 when the port allows (continuous 10–40 MHz need USB 3).</span>
        )}
        {(open || sel) && (
          <span className="note">
            {gapped
              ? 'Recording: needs a continuous span (5 MHz or less here)'
              : `Recording at this span: ${bytes(recRate)}/s${diskFree ? ` · ${bytes(diskFree)} free (~${fmtDur(secsLeft)})` : ''}`}
          </span>
        )}
      </Section>
      <Section id="tuning" title="Tuning" prefs={prefs} updatePrefs={updatePrefs}>
        <Seg wide value={band} disabled={locked} title={lockTitle} options={[['2.4', '2.4 GHz'], ['5', '5 GHz']]} onChange={(b) => pickBand(b as '2.4' | '5')} />
        <label className="field" title={lockTitle}>
          Channel
          <select
            disabled={locked}
            value={chan ? channelKey(chan) : ''}
            onChange={(e) => pickChannel(e.target.value)}
            title="Sets the centre frequency only; how wide a slice you see is Span"
          >
            <option value="" disabled>
              custom ({mhz(cur.freq, 0)} MHz)
            </option>
            {band === '2.4' ? (
              CHANNELS.filter((c) => c.band === '2.4').map((c) => (
                <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
              ))
            ) : (
              <>
                <optgroup label="20 MHz channels">
                  {CHANNELS.filter((c) => c.band === '5' && c.width === 20).map((c) => (
                    <option key={channelKey(c)} value={channelKey(c)}>{`${c.label} · ${mhz(c.centre, 0)} MHz`}</option>
                  ))}
                </optgroup>
                <optgroup label="Centre of a 40 MHz pair">
                  {CHANNELS.filter((c) => c.width === 40).map((c) => (
                    <option key={channelKey(c)} value={channelKey(c)}>{`${c.ch + 2} · ${mhz(c.centre, 0)} MHz (centre of ${c.label})`}</option>
                  ))}
                </optgroup>
              </>
            )}
          </select>
        </label>
        <label className="field" title={lockTitle}>
          Span
          <select
            disabled={locked}
            value={cur.rate_sel}
            // the centre stays as asked; a 40 MHz span centres within 2422-2462 / 5090-6155 MHz, so the
            // radio may sit beside it (the plot marks the requested frequency)
            onChange={(e) => userSet({ rate_sel: Number(e.target.value), wide: true })}
            title={`Bandwidth shown = sample rate (complex IQ). This adapter: up to ${spanLabel(Math.max(...rates.map((r) => r.fs)))}${
              rates.some((r) => r.gapped)
                ? '. "gapped": wider than USB 2 can carry continuously; the adapter captures short slices (spectrum and waterfall, no recording)'
                : ''
            }`}
          >
            {rates.map((r) => (
              <option key={r.rate_sel} value={r.rate_sel}>
                {r.gapped ? `${spanLabel(r.fs)} · gapped ~${Math.round(gappedDuty(r.hw_fs ?? r.fs) * 100)} %` : `${spanLabel(r.fs)} · ${r.fs / 1e6} MS/s`}
              </option>
            ))}
          </select>
        </label>
        {gapped && (
          <span className="note">
            Gapped: the adapter captures short slices of this span and ships each over USB 2, so only part of the time is
            seen. Spectrum and waterfall, no recording.
          </span>
        )}
        {fsNow >= 40e6 && band === '2.4' && (
          <span className="note">A 40 MHz span centres between 2422 and 2462 MHz: the requested frequency is marked on the plot.</span>
        )}
        {p.linksBox}
        {chip.includes('8822C') && (
          <label
            className="check"
            title="Off: the view is what the adapter's own receiver sees, its centre notch included. On: the 10 and 20 MHz views are cut from a 40 MHz capture tuned beside the channel, so the notch stays out of view (less of the time is sampled)."
          >
            <input type="checkbox" checked={prefs.offsetTuning} onChange={(e) => updatePrefs({ offsetTuning: e.target.checked })} />
            Avoid the chip&apos;s centre notch
          </label>
        )}
      </Section>
      <Section id="gain" title="Gain" prefs={prefs} updatePrefs={updatePrefs}>
        <div className="row" title={lockTitle}>
          <input
            type="range"
            aria-label={`Gain of view ${name}`}
            disabled={cur.agc || locked}
            min={0}
            max={caps.gain_max ?? 49}
            step={caps.gain_step ?? 1}
            value={gainUi ?? cur.gain_db}
            onChange={(e) => onGain(Number(e.target.value))}
          />
          <span className="val">{cur.agc ? 'auto' : `${(gainUi ?? cur.gain_db).toFixed(0)} dB`}</span>
        </div>
        <label className="check" title="Let the chip's AGC set the gain (it steps down during frames)">
          <input type="checkbox" disabled={locked} checked={cur.agc} onChange={(e) => userSet({ agc: e.target.checked })} />
          AGC
        </label>
      </Section>
    </>
  );

  const legend: [string, string, boolean, () => void][] = [
    ['average', twoPaths ? '#a3aebb' : VIEW_COLOUR[slot], prefs.showAvg, () => updatePrefs({ showAvg: !prefs.showAvg })],
    ['peak', '#8d99a8', prefs.showPeak, () => updatePrefs({ showPeak: !prefs.showPeak })],
  ];
  if (mode === 'compare') legend.push([`${SLOT_NAME[slot ^ 1]} overlay`, VIEW_COLOUR[slot ^ 1], prefs.ghost, () => updatePrefs({ ghost: !prefs.ghost })]);
  if (twoPaths) {
    const toggle = (path: 'a' | 'b') => {
      const on = new Set(dsp.paths.split(''));
      if (on.has(path)) on.delete(path);
      else on.add(path);
      if (on.size) setPaths(on.has('a') && on.has('b') ? 'ab' : [...on][0]);
    };
    legend.push(['Ant 1', '#ffab70', dsp.paths.includes('a'), () => toggle('a')]);
    legend.push(['Ant 2', '#8fd694', dsp.paths.includes('b'), () => toggle('b')]);
  }

  return (
    <section className={`view s${slot}${dual && selected ? ' sel' : ''}${lost ? ' lost' : ''}`} onMouseDown={p.onSelect} onFocusCapture={p.onSelect} aria-label={`View ${name}`}>
      <header className="vhead">
        {dual && <span className={`slotchip s${slot}`}>{name}</span>}
        <div className="freqbox" title={lockTitle}>
          <button aria-label="Tune down 5 MHz (Shift: 20 MHz)" disabled={locked} onClick={(e) => tuneTo(cur.freq - (e.shiftKey ? 20e6 : 5e6))}>
            ‹
          </button>
          <input
            ref={freqInput}
            className="freq"
            aria-label={`Centre frequency of view ${name}, MHz`}
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
          <button aria-label="Tune up 5 MHz (Shift: 20 MHz)" disabled={locked} onClick={(e) => tuneTo(cur.freq + (e.shiftKey ? 20e6 : 5e6))}>
            ›
          </button>
        </div>
        <span className="muted">MHz</span>
        <span className="muted chlabel">
          · {chan ? `${chanShort(chan)} · ` : ''}
          {spanLabel(fsNow)} span
        </span>
        {offGrid && (
          <span className="amber" title="At a 40 MHz span the radio centres within 2422–2462 / 5090–6155 MHz, or on its 5 MHz grid; the requested frequency is marked on the plot">
            <span className="long">requested {mhz(cur.freq, 0)} · </span>tuned {mhz(tuned, 0)}
            <span className="long"> ({Math.abs(tuned - cur.freq) >= 4.99e6 ? '40 MHz centres' : '5 MHz steps'})</span>
          </span>
        )}
        {runGapped && (
          <span
            className="badge"
            title={`Each slice is 8192 samples; the gaps between them are the time USB 2 needs to ship one${
              st?.offset && st.hw_centre ? `. Radio at ${mhz(st.hw_centre)} MHz (keeps the chip notch out of view)` : ''
            }`}
          >
            GAPPED<span className="long"> · {gappedPct !== null ? `~${gappedPct} %` : 'part of the time'} sampled</span>
          </span>
        )}
        <span className="spacer" />
        <div className="legend">
          {legend.map(([label, colour, on, fn]) => (
            <button key={label} className={on ? 'on' : 'off'} aria-pressed={on} aria-label={label} onClick={fn} title={`${on ? 'Hide' : 'Show'} ${label}${dual && !label.startsWith('Ant') ? ' (both views)' : ''}`}>
              <span className="swatch" style={{ background: colour }} />
              <span className="ltext">{label}</span>
            </button>
          ))}
        </div>
        <span className="state" title={stateText}>
          <span className={dotClass} />
          <span className="stext">{stateText}</span>
        </span>
        {!open ? (
          <button disabled={!sel || opening || !connected || !sel.can_open} onClick={() => void doStart()}>
            {opening ? 'Starting…' : '▶ Start'}
          </button>
        ) : (
          <button onClick={() => req('close').catch(() => {})} title={recording ? 'Stop the radio (also ends and saves the recording)' : 'Stop the radio'}>
            ■ Stop
          </button>
        )}
        <button
          className={recording ? 'rec on' : 'rec'}
          disabled={!recording && (!open || rxState !== 'streaming' || gapped || runGapped)}
          onClick={toggleRecord}
          title={recTitle}
        >
          {recording && status
            ? `■ End rec ${fmtClock(status.record.seconds)} · ${bytes(status.record.bytes)}`
            : gapped
              ? '● Rec · ≤ 5 MHz'
              : '● Rec'}
        </button>
      </header>

      <main className="plots">
        <div className="strips">
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
        </div>
        {connected && !fatal && !open && !opening && (lost ? (
          <div className="vcard lost" role="status">
            <h2>Unplugged · waiting for it to come back</h2>
            <p>
              View {name} starts again by itself when the adapter is back
              {saved ? ' (the recording was saved)' : ''}. The last picture stays, dimmed.
            </p>
            <button onClick={() => setLost(null)}>Stop waiting</button>
          </div>
        ) : !devices.length ? (
          <div className="vcard" role="status">
            <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#8e99a7" strokeWidth="1.6">
              <rect x="6" y="3" width="12" height="11" rx="2" />
              <path d="M9 14v4h6v-4" />
              <line x1="10" y1="21" x2="14" y2="21" />
            </svg>
            <h2>No adapter found</h2>
            <p>Plug in an RTL8812BU or RTL8812CU. It appears here by itself; Rescan looks again now.</p>
            <button onClick={() => req('scan').catch(() => {})}>⟳ Rescan</button>
          </div>
        ) : sel && !sel.can_open ? (
          <div className="vcard" role="status">
            <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#e0b46a" strokeWidth="1.6">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <h2>{sel.model} found, but this user cannot open it</h2>
            <p>Run this once in the wifi-sdr folder (it asks for your password), then unplug and replug the adapter:</p>
            <code className="cmd">{UDEV_CMD}</code>
            <button onClick={() => copy(UDEV_CMD)}>Copy command</button>
          </div>
        ) : null)}
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

      {(warn.length > 0 || (!prefs.retuned && open && !recording) || (recording && secsLeft < 60)) && (
        <footer className="vfoot">
          {warn.map((w) => (
            <span key={w} className="warn">
              {w}
            </span>
          ))}
          {recording && secsLeft < 60 && <span className="warn">disk nearly full: {fmtDur(secsLeft)} left</span>}
          {!prefs.retuned && open && !recording && <span className="hint">tip: double-click the spectrum to tune there</span>}
        </footer>
      )}
      {selected && p.sidebar && createPortal(sidebar, p.sidebar)}
    </section>
  );
}
