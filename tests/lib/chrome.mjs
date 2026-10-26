// SPDX-License-Identifier: GPL-2.0-only
// Chrome on the dongle, for the web tests: serves a directory with wasm/serve.mjs (COOP/COEP), starts a
// visible Chrome with a profile in which the adapter is already paired, and drives the page over the
// DevTools protocol. WebUSB's chooser cannot be automated: pair once by hand with
//   WSDR_CHROME_PROFILE=~/.cache/wsdr-chrome node tests/lib/chrome.mjs --pair
// then pass the same WSDR_CHROME_PROFILE to the tests. WebUSB permissions are per origin: keep the port
// (8080) the same as when pairing.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startChrome({ root, path = "/", port = 8080, cdpPort = 9333 }) {
  const profile = process.env.WSDR_CHROME_PROFILE;
  if (!profile) throw new Error('set WSDR_CHROME_PROFILE (a Chrome profile with the adapter paired; see tests/lib/chrome.mjs)');
  const server = spawn('node', [`${repo}/wasm/serve.mjs`, String(port), `${repo}/${root}`], { stdio: 'ignore' });
  const chrome = spawn(process.env.CHROME ?? 'google-chrome-stable',
    [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter((t) => t.type === 'page');
      if (!targets.length) targets = undefined;
    } catch {}
    if (!targets) await sleep(200);
  }
  if (!targets) throw new Error('Chrome did not start');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const pend = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  };
  const send = (method, params = {}) => new Promise((r) => { pend.set(++n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  // Evaluate in the page (awaits promises); throws the page's exception.
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const url = `http://localhost:${port}${path}`;
  const load = async (u = url) => {
    await send('Page.enable');
    await send('Page.navigate', { url: u });
    for (let i = 0; i < 100 && (await ev('document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(100);
  };
  await load();
  return {
    ev, send, sleep, url, load,
    reload: () => load(),
    // Wait until expr is truthy (polled), or throw after ms.
    until: async (expr, ms, what = expr) => {
      const t = Date.now();
      while (Date.now() - t < ms) {
        const v = await ev(expr).catch(() => undefined);
        if (v) return v;
        await sleep(250);
      }
      throw new Error(`timed out (${ms} ms): ${what}`);
    },
    close: () => { ws.close(); chrome.kill(); server.kill(); },
    keepOpen: () => { ws.close(); }, // --pair: leave Chrome for the user
  };
}

// --pair: open a page with a Pair button and leave Chrome running for the user.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--pair')) {
  const c = await startChrome({ root: 'wasm/web', path: '/core/pair.html' });
  console.log(`Chrome is open on ${c.url}: press "Pair adapter", choose the dongle, then close Chrome.`);
  c.keepOpen();
}
