// SPDX-License-Identifier: GPL-2.0-only
// Pairing an adapter with the page (WebUSB's chooser): filters, closed chooser, real failures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USB_FILTERS, pairAdapter } from '../src/pairing';

test('pairAdapter asks for the two Realtek adapters and reports a pairing', async () => {
  let asked: unknown = null;
  const r = await pairAdapter({ requestDevice: async (o: any) => ((asked = o.filters), {} as any) } as any);
  assert.equal(r, 'paired');
  assert.deepEqual(asked, [{ vendorId: 0x0bda, productId: 0xb812 }, { vendorId: 0x0bda, productId: 0xc812 }]);
  assert.deepEqual(USB_FILTERS, asked);
});

test('pairAdapter: closing the chooser is a cancel, not an error', async () => {
  const r = await pairAdapter({ requestDevice: async () => { throw new DOMException('', 'NotFoundError'); } } as any);
  assert.equal(r, 'cancelled');
});

test('pairAdapter: other failures are thrown', async () => {
  await assert.rejects(pairAdapter({ requestDevice: async () => { throw new DOMException('no', 'SecurityError'); } } as any), { name: 'SecurityError' });
});
