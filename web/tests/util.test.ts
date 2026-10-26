// SPDX-License-Identifier: GPL-2.0-only
// The "disk nearly full" warning while recording: only when the free space is known.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diskWarning } from '../src/util';

test('diskWarning: unknown free space (the web build) never warns', () => {
  assert.equal(diskWarning(undefined, 20e6), null);
});

test('diskWarning: under a minute of room warns, with the time left', () => {
  assert.equal(diskWarning(600e6, 20e6), 'disk nearly full: 30 s left');
  assert.equal(diskWarning(0, 20e6), 'disk nearly full: 0 s left');
});

test('diskWarning: a minute or more of room is fine', () => {
  assert.equal(diskWarning(1200e6, 20e6), null);
});
