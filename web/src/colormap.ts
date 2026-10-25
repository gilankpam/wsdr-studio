// SPDX-License-Identifier: GPL-2.0-only
// Turbo colormap (Google, Apache-2.0 polynomial approximation) as a 256-entry RGBA LUT.

function turbo(x: number): [number, number, number] {
  x = Math.min(1, Math.max(0, x));
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  const c = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
  return [c(r), c(g), c(b)];
}

export const TURBO: Uint32Array = (() => {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = turbo(i / 255);
    lut[i] = (255 << 24) | (b << 16) | (g << 8) | r; // little-endian RGBA for ImageData
  }
  return lut;
})();
