// SPDX-License-Identifier: GPL-2.0-only
// The web build: let this page use an adapter (WebUSB's chooser; Chrome remembers the choice per
// adapter, by its serial number).
export const USB_FILTERS = [
  { vendorId: 0x0bda, productId: 0xb812 }, // RTL8812BU
  { vendorId: 0x0bda, productId: 0xc812 }, // RTL8812CU
];

export type UsbLike = { requestDevice(o: { filters: typeof USB_FILTERS }): Promise<unknown> };

// 'cancelled': the chooser was closed without a choice.
export async function pairAdapter(usb: UsbLike): Promise<'paired' | 'cancelled'> {
  try {
    await usb.requestDevice({ filters: USB_FILTERS });
    return 'paired';
  } catch (e) {
    if ((e as { name?: string })?.name === 'NotFoundError') return 'cancelled';
    throw e;
  }
}

export const PAIR_TITLE = 'Let this page use a Realtek 8812BU / 8812CU (Chrome asks once per adapter)';
