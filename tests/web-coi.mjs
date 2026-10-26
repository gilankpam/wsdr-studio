// SPDX-License-Identifier: GPL-2.0-only
// The web build on a host that cannot send COOP/COEP (GitHub Pages): a plain static server. The bundled
// coi-serviceworker must make the page cross-origin isolated (after one reload), and the app must stream.
//   WSDR_CHROME_PROFILE=... node tests/web-coi.mjs
import { startChrome } from './lib/chrome.mjs';

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const c = await startChrome({ root: 'web/dist-web', path: '/?e2e', plain: true });
try {
  const h = (await fetch(c.url.replace(/\?.*/, ''))).headers;
  check(!h.get('cross-origin-opener-policy') && !h.get('cross-origin-embedder-policy'), 'the server sends no COOP/COEP');
  // a profile that ran this before keeps the service worker: start from none
  await c.ev(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())))`);
  await c.reload();
  await c.until('crossOriginIsolated === true && !!navigator.serviceWorker.controller', 20000, 'isolated after the automatic reload');
  check(true, 'coi-serviceworker made the page cross-origin isolated');
  await c.until('window.__hub', 20000, '__hub');
  await c.ev(`(window.__e2e = { events: [], rows: 0 }, __hub.subscribe({ slot: 0, event: (e) => __e2e.events.push(e), row: () => __e2e.rows++ }), 1)`);
  await c.until(`__e2e.events.some((e) => e.type === 'devices' && e.devices.length)`, 20000, 'adapter listed');
  const o = await c.ev(`__hub.request('open', { slot: 0, pid: 0xc812, rate_sel: 4 }).then((r) => r.type, (e) => e.message)`);
  check(o === 'ack', `open acked (${o})`);
  await c.sleep(2000); // the stream's first second
  const r0 = await c.ev('__e2e.rows');
  await c.sleep(5000);
  const r1 = await c.ev('__e2e.rows');
  check(r1 - r0 >= 100, `streaming (${r0} -> ${r1} rows; ${JSON.stringify(await c.ev(`__e2e.events.filter((e) => e.type === 'status').at(-1)?.rx`))})`);
  await c.ev(`__hub.request('close', { slot: 0 })`);
} catch (e) {
  check(false, e.message);
} finally {
  c.close();
}
console.log(fails ? `${fails} FAILED` : 'web-coi passed');
process.exit(fails ? 1 : 0);
