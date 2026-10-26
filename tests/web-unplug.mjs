// SPDX-License-Identifier: GPL-2.0-only
// Unplug / replug while streaming, in the web version (needs a person at the dongle): the view must say
// the adapter was lost, and stream again by itself once it is back (WebUSB: a new device, same serial).
//   WSDR_CHROME_PROFILE=... node tests/web-unplug.mjs
import { startChrome } from './lib/chrome.mjs';

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const c = await startChrome({ root: 'web/dist-web', path: '/?e2e' });
const rx = () => c.ev(`__e2e.events.filter((e) => e.type === 'status' && e.slot === 0).at(-1)?.rx`);
try {
  await c.until('window.__hub', 20000, '__hub');
  await c.ev(`(window.__e2e = { events: [], rows: 0 }, __hub.subscribe({ slot: 0, event: (e) => __e2e.events.push(e), row: () => __e2e.rows++ }), 1)`);
  await c.until(`__e2e.events.some((e) => e.type === 'devices' && e.devices.length)`, 20000, 'adapter listed');
  // Start the way the user does: the Station's button (its replug logic is what is under test)
  await c.ev(`[...document.querySelectorAll('button')].find((b) => /Start/.test(b.textContent) && !b.disabled).click()`);
  await c.until(`__e2e.rows > 50`, 120000, 'streaming');
  console.log('>>> UNPLUG the dongle now (waiting up to 60 s)');
  await c.until(`__e2e.events.some((e) => e.type === 'alert' && e.kind === 'lost')`, 60000, 'the adapter is reported lost');
  check(true, 'unplugged: the view says the adapter is lost');
  const shown = await c.ev(`document.body.innerText.match(/disconnected|unplugged|plug it back/i)?.[0] ?? ''`);
  check(!!shown, `the page says so ("${shown}")`);
  console.log('>>> PLUG it back in now (waiting up to 120 s: bring-up takes ~40 s)');
  const before = await c.ev('__e2e.rows');
  await c.until(`__e2e.rows > ${before} + 50`, 120000, 'streaming again by itself');
  const r = await rx();
  check(r?.state === 'streaming', `streaming again by itself (${r?.state})`);
} catch (e) {
  check(false, e.message);
} finally {
  c.close();
}
console.log(fails ? `${fails} FAILED` : 'web-unplug passed');
process.exit(fails ? 1 : 0);
