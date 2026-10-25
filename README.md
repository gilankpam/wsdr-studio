# wsdr-studio

A desktop app that turns a Realtek RTL8812BU (and RTL8812CU) USB Wi-Fi dongle into a live spectrum
receiver: plug it in, pick a Wi-Fi channel, watch the spectrum and waterfall.

**Status:** design only. Nothing is built yet; see [docs/DESIGN.md](docs/DESIGN.md).

- **What it uses:** the receive path from [wifi-sdr](https://github.com/snokvist/wifi-sdr), which
  streams the chip's baseband sample ring (LA mode) over USB with custom on-chip code. On the 8812BU
  over USB 3 that is up to 40 MS/s with the full 40 MHz band; on the 8812CU (USB 2) 2.5/5 MS/s on
  two coherent antennas.
- **What it is not:** a transmitter. The app is receive-only.
- **Platform:** Linux desktop first.

License: GPL-2.0-only (it links wifi-sdr and devourer, both GPL-2.0).
