// SPDX-License-Identifier: GPL-2.0-only
// Picking the transport (Electron's WebSocket or the web build's worker) and the worker client's
// protocol: ready/open, requests and their replies, rows, a fatal load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEEDS_CHROME, NEEDS_ISOLATION, openTransport } from '../src/transport';
import { WorkerClient, type WorkerLike } from '../src/workerClient';

class FakeWorker implements WorkerLike {
  sent: any[] = [];
  onmessage: ((e: { data: any }) => void) | null = null;
  terminated = false;
  postMessage(m: unknown) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  emit(data: any) { this.onmessage?.({ data }); }
}

const bridge = { session: async () => ({ token: 't0k' }) };
const loc = { protocol: 'http:', host: '127.0.0.1:8073' };

test('openTransport: the Electron bridge means the WebSocket', async () => {
  const t = await openTransport({ bridge, location: loc });
  assert.equal(t.kind, 'desktop');
});

test('openTransport: WebUSB, isolation and JSPI mean the worker', async () => {
  const w = new FakeWorker();
  const t = await openTransport({ usb: {}, isolated: true, jspi: true, makeWorker: () => w });
  assert.equal(t.kind, 'web');
});

test('openTransport: a capable browser in a page not yet isolated is told so, not sent to another browser', async () => {
  await assert.rejects(openTransport({ usb: {}, isolated: false, jspi: true, makeWorker: () => new FakeWorker() }), { message: NEEDS_ISOLATION });
  assert.match(NEEDS_ISOLATION, /reload/i);
  assert.doesNotMatch(NEEDS_ISOLATION, /version 137/);
});

test('openTransport: anything else says which browser is needed', async () => {
  await assert.rejects(openTransport({}), { message: NEEDS_CHROME });
  await assert.rejects(openTransport({ usb: {}, isolated: true, jspi: false, makeWorker: () => new FakeWorker() }), { message: NEEDS_CHROME });
  assert.equal(NEEDS_CHROME, 'wsdr-studio needs Chrome or Chromium (version 137 or newer) on a desktop computer.');
});

function connected() {
  const w = new FakeWorker();
  const c = new WorkerClient(() => w);
  const ups: boolean[] = [];
  c.onConnection = (up) => ups.push(up);
  c.connect();
  w.emit({ t: 'ready' });
  return { w, c, ups };
}

test('WorkerClient: ready -> connected, and the worker is told a client opened', () => {
  const { w, ups } = connected();
  assert.deepEqual(ups, [true]);
  assert.deepEqual(w.sent.at(-1), { t: 'open' });
});

test('WorkerClient: a request goes out as protocol JSON and resolves on its ack', async () => {
  const { w, c } = connected();
  const p = c.request('status', { slot: 0 });
  const m = w.sent.at(-1);
  assert.equal(m.t, 'text');
  const cmd = JSON.parse(m.text);
  assert.equal(cmd.cmd, 'status');
  assert.equal(cmd.slot, 0);
  assert.equal(typeof cmd.id, 'number');
  w.emit({ t: 'text', text: JSON.stringify({ type: 'ack', id: cmd.id, x: 1 }) });
  assert.equal((await p).x, 1);
});

test('WorkerClient: an error reply rejects with its message and kind', async () => {
  const { w, c } = connected();
  const p = c.request('open', { slot: 0 });
  const { id } = JSON.parse(w.sent.at(-1).text);
  w.emit({ t: 'text', text: JSON.stringify({ type: 'error', id, msg: 'x', kind: 'busy' }) });
  await assert.rejects(p, (e: Error & { kind?: string }) => e.message === 'x' && e.kind === 'busy');
});

test('WorkerClient: events go to onEvent, rows are decoded', () => {
  const { w, c } = connected();
  const events: any[] = [], rows: any[] = [];
  c.onEvent = (e) => events.push(e);
  c.onRow = (r) => rows.push(r);
  w.emit({ t: 'text', text: JSON.stringify({ type: 'status', slot: 1 }) });
  const bins = 4, buf = new ArrayBuffer(48 + 2 * bins), v = new DataView(buf);
  v.setUint32(0, 0x57525357, true);
  v.setUint16(4, 1, true);
  v.setUint8(6, 0x10); // slot B
  v.setUint32(12, bins, true);
  v.setFloat64(24, 5180e6, true);
  v.setFloat64(32, 1e6, true);
  v.setFloat32(40, -150, true);
  v.setFloat32(44, 0.6, true);
  w.emit({ t: 'bin', buf });
  assert.deepEqual(events, [{ type: 'status', slot: 1 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slot, 1);
  assert.equal(rows[0].bins, 4);
  assert.equal(rows[0].f0, 5180e6);
});

test('WorkerClient: a fatal load gives up with its message', () => {
  const w = new FakeWorker();
  const c = new WorkerClient(() => w);
  let why = '';
  c.onGiveUp = (m) => (why = m);
  c.connect();
  w.emit({ t: 'fatal', msg: 'no OPFS' });
  assert.equal(why, 'no OPFS');
});

test('WorkerClient: requests before ready are refused', async () => {
  const w = new FakeWorker();
  const c = new WorkerClient(() => w);
  c.connect();
  await assert.rejects(c.request('status'), { message: 'not connected' });
});
