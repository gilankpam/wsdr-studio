// SPDX-License-Identifier: GPL-2.0-only
// wsdr-core (the engine in WASM, wasm/core.cpp) on the 8812CU in Chrome, without the UI: protocol over
// the worker, streaming at 5 MS/s, slot claims, and release on reload. Needs wasm/build.sh jspi and an
// 8812CU paired in WSDR_CHROME_PROFILE (tests/lib/chrome.mjs).
//   WSDR_CHROME_PROFILE=... node tests/web-core.mjs
import { startChrome } from './lib/chrome.mjs';

const PID_CU = 0xc812;
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

const c = await startChrome({ root: 'wasm/web', path: '/core/test.html' });
try {
  await c.until('window.core?.ready', 30000, 'core ready');
  await c.until(`core.events.some((e) => e.type === 'devices')`, 15000, 'devices event');
  check(await c.ev(`core.events[0]?.type === 'hello'`), 'hello first');
  check(await c.ev(`core.events.find((e) => e.type === 'devices').devices.some((d) => d.pid === ${PID_CU})`), 'devices lists the 8812CU');

  const open = (slot) => c.ev(`core.request({cmd: 'open', slot: ${slot}, pid: ${PID_CU}, rate_sel: 4})`);
  const t0 = Date.now();
  const r = await open(0);
  check(r.type === 'ack', `open slot 0 acked (${((Date.now() - t0) / 1000).toFixed(1)} s) ${r.msg ?? ''}`);
  await c.sleep(2000);
  const rows0 = await c.ev('core.rows[0]');
  await c.sleep(15000);
  const rate = ((await c.ev('core.rows[0]')) - rows0) / 15;
  check(rate >= 20, `rows for slot 0 at ${rate.toFixed(1)}/s (>= 20)`);
  const st = await c.ev(`core.events.filter((e) => e.type === 'status' && e.slot === 0).at(-1)`);
  check(st?.rx?.restarts === 0, `no stream restarts (${st?.rx?.restarts})`);
  check(st?.ring_dropped === 0, `no banks dropped (${st?.ring_dropped})`);
  check(st?.disk_free === undefined, 'no disk_free on the web');

  // A stream restart inside the session (WebUSB cannot cancel the old run's reads: they must not
  // swallow the new run's first packets): a rate change, then a retune, then back.
  for (const [what, args] of [['rate 2.5 MS/s', { rate_sel: 5 }], ['retune 5240 MHz', { freq: 5240e6 }], ['back to 5 MS/s', { rate_sel: 4, freq: 5190e6 }]]) {
    const r = await c.ev(`core.request(${JSON.stringify({ cmd: 'set', slot: 0, ...args })})`);
    await c.sleep(4000);
    const n0 = await c.ev('core.rows[0]');
    await c.sleep(3000);
    const s2 = await c.ev(`core.events.filter((e) => e.type === 'status' && e.slot === 0).at(-1)`);
    check(r.type === 'ack' && s2?.rx?.restarts === 0 && (await c.ev('core.rows[0]')) - n0 >= 60,
      `${what}: still streaming, no restarts (${s2?.rx?.restarts}${s2?.rx?.error ? ': ' + s2.rx.error : ''})`);
  }

  const b = await open(1);
  check(b.type === 'error' && String(b.msg).startsWith('every adapter of this kind is open'), `slot 1 on the same adapter refused (${b.msg})`);

  await c.reload();
  await c.until('window.core?.ready', 30000, 'core ready after reload');
  const again = await open(0);
  check(again.type === 'ack', `open after reload acked ${again.msg ?? ''}`);
  await c.ev(`core.request({cmd: 'close', slot: 0})`);
} catch (e) {
  check(false, e.message);
} finally {
  c.close();
}
console.log(fails ? `${fails} FAILED` : 'web-core passed');
process.exit(fails ? 1 : 0);
