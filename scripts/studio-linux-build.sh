#!/usr/bin/env bash
# The in-container half of build-studio-linux.bat. Runs inside the ggs-linux-builder image
# (scripts/Dockerfile.studio-linux) with the repository mounted at /repo and a persistent
# cache volume at /cache. Keep this file LF-only: the container's bash cannot read CRLF.
set -euo pipefail

: "${REPO:=/repo}"
# Caches on the volume, not on the (slow, Windows-backed) repository mount. CARGO_TARGET_DIR
# also keeps the Linux artifacts out of target/studio/cargo, which the Windows MSVC builds own.
export CARGO_HOME=/cache/cargo
export CARGO_TARGET_DIR=/cache/target
export npm_config_cache=/cache/npm
# Tauri's AppImage step drives linuxdeploy, an AppImage itself; inside a container there is
# no FUSE, so it must extract-and-run instead of mounting itself.
export APPIMAGE_EXTRACT_AND_RUN=1

cd "$REPO"

echo "[container] app dependencies (adds the linux esbuild/tauri-cli binaries)"
npm install --no-audit --no-fund

echo "[container] building the installers (Rust release build + deb/rpm/AppImage bundling)"
# tauri build runs prepare.mjs and the Vite build itself (beforeBuildCommand); the extension
# assets it copies (plugin/out/, plugin/media/) were compiled on the host by
# build-studio-linux.bat, into the plugin submodule checkout it mounts at /repo/plugin.
npx tauri build

echo "[container] copying the bundles into the repository"
rm -rf "$REPO/target/studio/bundle-linux"
mkdir -p "$REPO/target/studio/bundle-linux"
cp -r "$CARGO_TARGET_DIR/release/bundle/." "$REPO/target/studio/bundle-linux/"

echo "[container] done:"
ls -l "$REPO/target/studio/bundle-linux"
