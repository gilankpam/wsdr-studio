// SPDX-License-Identifier: GPL-2.0-only
// The folder recordings go to (web build): the remembered one if this page may still write there,
// else the picker; a closed picker means no folder (and no recording).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureFolder, type FolderStore } from '../src/recordFolder';
import { FakeDir } from './fsfakes';

const store = (h?: FakeDir) => {
  const s = { h: h as any, sets: 0, get: async () => s.h, set: async (x: any) => { s.h = x; s.sets++; } };
  return s as FolderStore & { h: any; sets: number };
};
const never = async (): Promise<any> => { throw new Error('picker must not open'); };

test('ensureFolder: the remembered folder, while writable, without asking', async () => {
  const d = new FakeDir('rec');
  assert.equal(await ensureFolder(store(d), never), d);
  assert.equal(d.requested, 0);
});

test('ensureFolder: a remembered folder that needs a prompt is asked for again', async () => {
  const d = new FakeDir('rec');
  d.permission = 'prompt';
  assert.equal(await ensureFolder(store(d), never), d);
  assert.equal(d.requested, 1);
});

test('ensureFolder: a refused folder, or none, opens the picker and remembers the choice', async () => {
  const old = new FakeDir('old');
  old.permission = 'denied';
  const picked = new FakeDir('new');
  const s = store(old);
  assert.equal(await ensureFolder(s, async () => picked as any), picked);
  assert.equal(s.h, picked);
  assert.equal(await ensureFolder(store(), async () => picked as any), picked);
});

test('ensureFolder: record without folder (picker closed) gives null', async () => {
  const s = store();
  assert.equal(await ensureFolder(s, async () => { throw new DOMException('', 'AbortError'); }), null);
  assert.equal(s.sets, 0);
});
