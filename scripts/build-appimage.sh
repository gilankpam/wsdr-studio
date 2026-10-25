#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-only
# Build wsdr-studio-x86_64.AppImage.
#   - web UI: built on the host (npm); static files, architecture independent
#   - backend: built inside Ubuntu 22.04 (needs glibc >= 2.34 at run time) for wide compatibility
#   - libraries: linuxdeploy bundles FFTW; libusb is added explicitly (linuxdeploy's exclude list
#     skips it); libudev and libstdc++ stay the host's (libudev must match the host's udev)
#   - AppImage: appimagetool with the pinned static type-2 runtime (no libfuse2 needed on the host)
# Tools are pinned by version and SHA-256. Output: build-appimage/wsdr-studio-x86_64.AppImage
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$R/build-appimage"
TOOLS="$OUT/tools"
mkdir -p "$TOOLS"

LINUXDEPLOY_URL=https://github.com/linuxdeploy/linuxdeploy/releases/download/1-alpha-20251107-1/linuxdeploy-x86_64.AppImage
LINUXDEPLOY_SHA=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d
APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
APPIMAGETOOL_SHA=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_URL=https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64
RUNTIME_SHA=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
fetch() { # url sha file
  [ -f "$3" ] || curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "checksum mismatch: $3" >&2; rm -f "$3"; exit 1; }
  chmod +x "$3"
}
fetch "$LINUXDEPLOY_URL" "$LINUXDEPLOY_SHA" "$TOOLS/linuxdeploy-x86_64.AppImage"
fetch "$APPIMAGETOOL_URL" "$APPIMAGETOOL_SHA" "$TOOLS/appimagetool-x86_64.AppImage"
fetch "$RUNTIME_URL" "$RUNTIME_SHA" "$TOOLS/runtime-x86_64"

[ -f "$R/external/wifi-sdr/external/devourer/CMakeLists.txt" ] || {
  echo "submodules missing: git submodule update --init external/wifi-sdr && git -C external/wifi-sdr submodule update --init external/devourer" >&2
  exit 1
}

echo "== web UI"
(cd "$R/web" && npm ci --no-audit --no-fund --silent && npm run build --silent)

DOCKER=docker
docker ps >/dev/null 2>&1 || DOCKER="sudo docker"
echo "== backend + AppImage (ubuntu:22.04)"
$DOCKER run --rm -v "$R":/src:ro -v "$OUT":/out -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" ubuntu:22.04 bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends cmake g++ make pkg-config libusb-1.0-0-dev libfftw3-dev \
      libboost-dev nlohmann-json3-dev binutils-mipsel-linux-gnu xxd file ca-certificates >/dev/null
  cmake -S /src -B /tmp/b -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr >/dev/null
  cmake --build /tmp/b -j"$(nproc)" --target wsdr-studiod test_core
  /tmp/b/test_core
  rm -rf /tmp/AppDir && DESTDIR=/tmp/AppDir cmake --install /tmp/b >/dev/null
  test -f /tmp/AppDir/usr/share/wsdr-studio/web/index.html
  cd /tmp
  export APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64
  /out/tools/linuxdeploy-x86_64.AppImage --appdir /tmp/AppDir \
      --executable /tmp/AppDir/usr/bin/wsdr-studiod \
      --library /usr/lib/x86_64-linux-gnu/libusb-1.0.so.0 \
      --desktop-file /src/packaging/wsdr-studio.desktop --icon-file /src/packaging/wsdr-studio.svg >/dev/null
  rm -f /tmp/AppDir/usr/lib/libudev.so*
  test -f /tmp/AppDir/usr/lib/libusb-1.0.so.0
  /out/tools/appimagetool-x86_64.AppImage --no-appstream --runtime-file /out/tools/runtime-x86_64 \
      /tmp/AppDir /out/wsdr-studio-x86_64.AppImage >/dev/null
  chown "$HOST_UID:$HOST_GID" /out/wsdr-studio-x86_64.AppImage
'
ls -la "$OUT/wsdr-studio-x86_64.AppImage"
