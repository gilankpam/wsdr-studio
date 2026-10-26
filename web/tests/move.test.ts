// SPDX-License-Identifier: GPL-2.0-only
// Moving a finished recording (data + meta) from the page's storage into the user's folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveRecording } from '../src/core/move';
import { FakeDir } from './fsfakes';

const base = 'wsdr-20261026-113254-5180.000MHz-5Msps';
const filled = () => {
  const from = new FakeDir('opfs');
  from.files.set(`${base}.sigmf-data`, new Uint8Array(300000).map((_, i) => i * 7));
  from.files.set(`${base}.sigmf-meta`, new TextEncoder().encode('{"global":{}}'));
  from.files.set('other.sigmf-data', new Uint8Array([1]));
  return from;
};

test('moveRecording: both files arrive byte for byte and leave the page storage', async () => {
  const from = filled(), to = new FakeDir('rec');
  const data = from.files.get(`${base}.sigmf-data`)!, meta = from.files.get(`${base}.sigmf-meta`)!;
  const r = await moveRecording(from as any, to as any, base);
  assert.deepEqual(r, { moved: [`${base}.sigmf-data`, `${base}.sigmf-meta`] });
  assert.deepEqual(to.files.get(`${base}.sigmf-data`), data);
  assert.deepEqual(to.files.get(`${base}.sigmf-meta`), meta);
  assert.deepEqual([...from.files.keys()], ['other.sigmf-data']);
});

test('moveRecording: move failure keeps file and reports', async () => {
  const from = filled(), to = new FakeDir('rec');
  to.failWrite.add(`${base}.sigmf-meta`);
  const r = await moveRecording(from as any, to as any, base);
  assert.deepEqual(r.moved, [`${base}.sigmf-data`]);
  assert.match(r.error ?? '', new RegExp(`${base}\\.sigmf-meta`));
  assert.ok(from.files.has(`${base}.sigmf-meta`));
  assert.ok(!from.files.has(`${base}.sigmf-data`));
});
