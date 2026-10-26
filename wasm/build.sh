#!/usr/bin/env bash
# Build the WebUSB spike: libusb (Emscripten backend) -> wsdr-probe.{js,wasm} into wasm/web/.
#   wasm/build.sh [jspi|asyncify]
# Needs: emcc/emcmake, cmake, pkg-config, mipsel binutils (mipsel-*-as/ld/objcopy), xxd. On Nix:
#   nix shell nixpkgs#emscripten nixpkgs#cmake nixpkgs#pkg-config nixpkgs#xxd \
#     nixpkgs#pkgsCross.mipsel-linux-gnu.buildPackages.binutils -c wasm/build.sh
# LIBUSB_SRC: a libusb >= 1.0.27 source tree (default: fetched, pinned by sha256, into wasm/.deps).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mode=${1:-jspi}
deps=$here/.deps
out=$here/build-$mode
mkdir -p "$deps"

LIBUSB_VER=1.0.29
LIBUSB_SHA256=5977fc950f8d1395ccea9bd48c06b3f808fd3c2c961b44b0c2e6e29fc3a70a85
if [[ -z "${LIBUSB_SRC:-}" ]]; then
  LIBUSB_SRC=$deps/libusb-$LIBUSB_VER
  if [[ ! -d $LIBUSB_SRC ]]; then
    tb=$deps/libusb-$LIBUSB_VER.tar.bz2
    curl -fsSL -o "$tb" "https://github.com/libusb/libusb/releases/download/v$LIBUSB_VER/libusb-$LIBUSB_VER.tar.bz2"
    echo "$LIBUSB_SHA256  $tb" | sha256sum -c -
    tar -C "$deps" -xjf "$tb"
  fi
fi

# -pthread: libusb's Emscripten event loop uses wasm atomics (shared memory). No threads are started.
if [[ $mode == jspi ]]; then exc="-fwasm-exceptions;-pthread"; else exc="-fexceptions;-pthread"; fi

tool() { command -v "mipsel-linux-gnu-$1" || command -v "mipsel-unknown-linux-gnu-$1"; }

emcmake cmake -S "$here/libusb" -B "$out/libusb" -DCMAKE_BUILD_TYPE=Release -DLIBUSB_SRC="$LIBUSB_SRC" \
  -DWSDR_EXC_FLAGS="$exc" -DCMAKE_INSTALL_PREFIX="$out/prefix" >/dev/null
cmake --build "$out/libusb" -j
cmake --install "$out/libusb" >/dev/null

PKG_CONFIG_PATH=$out/prefix/lib/pkgconfig PKG_CONFIG_LIBDIR=$out/prefix/lib/pkgconfig \
emcmake cmake -S "$here" -B "$out/probe" -DCMAKE_BUILD_TYPE=Release -DWSDR_ASYNC="$mode" -DLIBUSB_PREFIX="$out/prefix" \
  -DMIPS_AS="$(tool as)" -DMIPS_LD="$(tool ld)" -DMIPS_OBJCOPY="$(tool objcopy)" >/dev/null
cmake --build "$out/probe" -j --target wsdr-probe
mkdir -p "$here/web/$mode"
cp "$out/probe/wsdr-probe.js" "$out/probe/wsdr-probe.wasm" "$here/web/$mode/"
ls -la "$here/web/$mode"
