// SPDX-License-Identifier: GPL-2.0-only
// The web version end to end on the 8812CU: the built app (web/dist-web, `npm run build:web`) in Chrome,
// driven through its own Hub (window.__hub, present with ?e2e). Single view streaming, the Wi-Fi switch,
// a Spectral-Map-style sweep of retunes, a 10 s recording into a "picked" folder (an OPFS subdirectory
// stands in for the user's: the picker cannot be automated), close. Needs WSDR_CHROME_PROFILE
// (tests/lib/chrome.mjs).
//   WSDR_CHROME_PROFILE=... node tests/web-e2e.mjs
import { startChrome } from './lib/chrome.mjs';

const PID_CU = 0xc812;
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const summary = {};

const c = await startChrome({ root: 'web/dist-web', path: '/?e2e' });
const req = (cmd, args = {}) => c.ev(`__hub.request(${JSON.stringify(cmd)}, ${JSON.stringify({ slot: 0, ...args })}).then((r) => r, (e) => ({ type: 'error', msg: e.message, kind: e.kind }))`);
const lastStatus = () => c.ev(`__e2e.events.filter((e) => e.type === 'status' && e.slot === 0).at(-1)`);
try {
  await c.until('window.__hub', 20000, 'the app exposes __hub (?e2e)');
  await c.ev(`(window.__e2e = { events: [], rows: [0, 0] }, __hub.subscribe({ slot: null, event: (e) => __e2e.events.push(e), all: (r) => __e2e.rows[r.slot]++ }), 1)`);
  await c.until(`__e2e.events.some((e) => e.type === 'devices' && e.devices.some((d) => d.pid === ${PID_CU}))`, 20000, 'the 8812CU is listed');

  // single view
  const t0 = Date.now();
  const o = await req('open', { pid: PID_CU, rate_sel: 4, freq: 5190e6 });
  check(o.type === 'ack', `open at 5 MS/s acked (${((Date.now() - t0) / 1000).toFixed(1)} s) ${o.msg ?? ''}`);
  await c.sleep(2000);
  const r0 = await c.ev('__e2e.rows[0]');
  await c.sleep(15000);
  summary.rows_per_s = ((await c.ev('__e2e.rows[0]')) - r0) / 15;
  check(summary.rows_per_s >= 20, `rows at ${summary.rows_per_s.toFixed(1)}/s (>= 20)`);
  let st = await lastStatus();
  check(st?.rx?.restarts === 0 && st?.ring_dropped === 0, `no restarts, no dropped banks (${st?.rx?.restarts}, ${st?.ring_dropped})`);
  summary.dsp_load = st?.dsp_load;

  // slot B with one adapter: the only one is A's; there is no 8812BU
  const b1 = await req('open', { slot: 1, pid: PID_CU });
  check(b1.type === 'error' && b1.kind === 'busy', `slot B on A's adapter: busy (${b1.msg})`);
  const b2 = await req('open', { slot: 1, pid: 0xb812 });
  check(b2.type === 'error' && b2.kind === 'not_found', `slot B, no 8812BU: not_found (${b2.msg})`);
  check(await c.ev(`['Panorama', 'Compare'].every((m) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent === m); return b?.disabled && b.title === 'Needs a second adapter'; })`),
    'Panorama and Compare: disabled, "Needs a second adapter"');

  // a second tab while this one streams: Chrome will not let it claim the adapter
  const tab = await c.openTab('/?e2e');
  await tab.until('window.__hub', 20000, 'second tab: __hub');
  await tab.ev(`(window.__ev = [], __hub.subscribe({ slot: null, event: (e) => __ev.push(e) }), 1)`);
  await tab.until(`__ev.some((e) => e.type === 'devices' && e.devices.length)`, 20000, 'second tab: adapter listed');
  const t2 = await tab.ev(`__hub.request('open', { slot: 0, pid: ${PID_CU} }).then((r) => r, (e) => ({ type: 'error', msg: e.message, kind: e.kind }))`);
  check(t2.type === 'error' && t2.kind === 'busy' && String(t2.msg).startsWith('Chrome could not claim the adapter'), `second tab: busy, with the Chrome hint (${t2.msg})`);
  await tab.close();
  const r1 = await c.ev('__e2e.rows[0]');
  await c.sleep(3000);
  st = await lastStatus();
  check(st?.rx?.restarts === 0 && (await c.ev('__e2e.rows[0]')) - r1 >= 60, `first tab still streaming (restarts ${st?.rx?.restarts})`);

  // Wi-Fi (the finder runs on continuous 20/40 MS/s only: on the 8812CU, gapped, it finds nothing)
  check((await req('dsp', { wifi: true })).type === 'ack', 'Wi-Fi marks on: acked');
  check((await req('set', { freq: 2437e6, rate_sel: 2, allow_gapped: true })).type === 'ack', 'set 2437 MHz, 20 MHz gapped: acked');
  const w0 = await c.ev(`__e2e.events.length`);
  await c.sleep(20000);
  summary.wifi_frames = await c.ev(`__e2e.events.slice(${w0}).filter((e) => e.type === 'wifi').reduce((n, e) => n + e.frames.length, 0)`);
  summary.wifi_networks = await c.ev(`[...new Set(__e2e.events.slice(${w0}).filter((e) => e.type === 'wifi').flatMap((e) => e.frames.map((f) => f[10]).filter(Boolean)))].length`);
  console.log(`info Wi-Fi in 20 s on 2437 MHz: ${summary.wifi_frames} frames, ${summary.wifi_networks} named networks (not exercised on the 8812CU: gapped)`);
  await req('dsp', { wifi: false });

  // sweep, the Spectral Map's pattern: retunes every 300 ms
  const back = await req('set', { freq: 5180e6, rate_sel: 4, allow_gapped: false });
  check(back.type === 'ack', `back to 5 MS/s continuous ${back.msg ?? ''}`);
  for (const e of await c.ev(`__e2e.events.filter((e) => e.type === 'alert' || e.type === 'notice')`)) console.log('info event', JSON.stringify(e));
  const a0 = await c.ev(`__e2e.events.length`);
  let acks = 0;
  for (let i = 0; i < 20; i++) {
    const r = await req('set', { freq: (5180 + 20 * (i % 8)) * 1e6, rate_sel: 4, allow_gapped: false });
    acks += r.type === 'ack';
    await c.sleep(300);
  }
  await c.sleep(3000);
  check(acks === 20, `20 retunes acked (${acks})`);
  check(!(await c.ev(`__e2e.events.slice(${a0}).some((e) => e.type === 'alert' && e.kind === 'failed')`)), 'no failure alert during the sweep');
  st = await lastStatus();
  check(st?.rx?.restarts === 0 && st?.state === 'open', `still streaming after the sweep (restarts ${st?.rx?.restarts}, ${st?.state})`);

  // recording: 10 s at 5 MS/s (20 MB/s) into the folder, via the page's storage
  await c.ev(`(async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('e2e-picked', { recursive: true }).catch(() => {});
    window.__picked = await root.getDirectoryHandle('e2e-picked', { create: true });
    __hub.setRecordFolder(__picked);
  })()`);
  const r0n = await c.ev(`__e2e.events.length`);
  const rs = await req('record', { action: 'start' });
  check(rs.type === 'ack', `record start ${rs.file ?? rs.msg ?? ''}`);
  await c.sleep(10000);
  check((await req('record', { action: 'stop' })).type === 'ack', 'record stop');
  const rec = await c.until(`__e2e.events.slice(${r0n}).find((e) => e.type === 'recorded')`, 60000, 'recorded event');
  check(!rec.error, `recorded without error ${rec.error ?? ''}`);
  check(String(rec.file).startsWith('e2e-picked/'), `the event names the picked folder (${rec.file})`);
  const base = String(rec.file).replace(/^.*\//, '').replace(/\.sigmf-data$/, '');
  const got = await c.ev(`(async () => {
    const size = async (d, n) => (await (await d.getFileHandle(n)).getFile()).size;
    const meta = JSON.parse(await (await (await __picked.getFileHandle('${base}.sigmf-meta')).getFile()).text());
    const left = [];
    for await (const [n] of (await navigator.storage.getDirectory()).entries()) if (n.startsWith('${base}')) left.push(n);
    return { data: await size(__picked, '${base}.sigmf-data'), rate: meta.global['core:sample_rate'], left };
  })()`);
  summary.recording_mb = got.data / 1e6;
  check(Math.abs(got.data - 200e6) <= 0.02 * 200e6, `data file ${(got.data / 1e6).toFixed(1)} MB (200 MB +- 2 %)`);
  check(got.rate === 5000000, `meta core:sample_rate ${got.rate}`);
  check(got.left.length === 0, `the recording left the page storage (${got.left.join(', ')})`);

  check((await req('close')).type === 'ack', 'close acked');
  await c.sleep(1000);
  check((await c.ev(`__e2e.events.filter((e) => e.type === 'caps' && e.slot === 0).at(-1)?.open`)) === false, 'caps: closed');
} catch (e) {
  check(false, e.message);
} finally {
  c.close();
}
console.log('summary', JSON.stringify(summary));
console.log(fails ? `${fails} FAILED` : 'web-e2e passed');
process.exit(fails ? 1 : 0);
