// SPDX-License-Identifier: GPL-2.0-only
// The web version end to end on the 8812CU: the built app (web/dist-web, `npm run build:web`) in Chrome,
// driven through its own Hub (window.__hub, present with ?e2e). Single view streaming, the Wi-Fi switch,
// a Spectral-Map-style sweep of retunes, close. Needs WSDR_CHROME_PROFILE (tests/lib/chrome.mjs).
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
