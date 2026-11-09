// SPDX-License-Identifier: GPL-2.0-only
// The worker around wsdr-core (wasm/core.cpp), for the tests (tests/web-core.mjs); the app's own is
// web/src/core/worker.ts. Page -> worker: {t:'open'} (a client connects), {t:'text', text} (a command).
// Worker -> page: {t:'ready'}, {t:'fatal', msg}, {t:'text', text}, {t:'bin', buf} (buf transferred),
// {t:'log', text} (the module's stdout / stderr).
import createCore from './wsdr-core.js';

const queue = [];
let mod = null;
const handle = (m) => {
  if (m.t === 'open') mod._core_client_open();
  else if (m.t === 'text') {
    const p = mod.stringToNewUTF8(m.text);
    mod._core_text(p);
    mod._free(p);
  }
};
self.onmessage = ({ data }) => (mod ? handle(data) : queue.push(data));

try {
  const m = await createCore({
    onCoreText: (text) => self.postMessage({ t: 'text', text }),
    onCoreBinary: (u8) => self.postMessage({ t: 'bin', buf: u8.buffer }, [u8.buffer]),
    print: (text) => self.postMessage({ t: 'log', text }),
    printErr: (text) => self.postMessage({ t: 'log', text }),
  });
  const dir = m.stringToNewUTF8('/recordings');
  const rc = m._core_start(dir);
  m._free(dir);
  if (rc) throw new Error('cannot open the browser storage for recordings (OPFS)');
  mod = m;
  self.postMessage({ t: 'ready' });
  for (const q of queue.splice(0)) handle(q);
} catch (e) {
  self.postMessage({ t: 'fatal', msg: String(e?.message ?? e) });
}
