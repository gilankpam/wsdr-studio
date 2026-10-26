// The probe in a dedicated worker, so the page's thread stays free while USB is busy.
import { env, loadProbe } from './probe-host.js';

const mode = new URL(self.location.href).searchParams.get('mode') ?? 'jspi';
const post = (m) => self.postMessage(m);
post({ env: env() });

let call = null;
const ready = env().usb
  ? loadProbe(mode, post).then((c) => (call = c))
  : Promise.reject(new Error('navigator.usb is not available in a dedicated worker'));
ready.then(() => post({ ready: true }), (e) => post({ fatal: String(e) }));

self.onmessage = async ({ data: { id, cmd, args } }) => {
  try {
    await ready;
    const t = performance.now();
    const rc = await call(cmd, args);
    post({ id, rc, ms: performance.now() - t });
  } catch (e) {
    post({ id, error: String(e?.stack ?? e) });
  }
};
