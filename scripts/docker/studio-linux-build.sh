#!/usr/bin/env bash
# The in-container half of scripts/build-studio-linux.bat. Runs inside the ggs-linux-builder
# image (scripts/docker/Dockerfile.studio-linux) with the repository mounted at /repo and a
# persistent cache volume at /cache. Keep this file LF-only: the container's bash cannot read
# CRLF (enforced by .gitattributes).
set -euo pipefail

: "${REPO:=/repo}"
# What tauri build bundles, and where the installers land under target/studio/ - both set
# by the caller so the same image serves the deb pass (ubuntu:22.04 base) and the rpm pass
# (fedora:38 base).
: "${BUNDLES:=deb}"
: "${OUT_DIR:=bundle-linux}"
# Caches on the volume, not on the (slow, Windows-backed) repository mount. CARGO_TARGET_DIR
# also keeps the Linux artifacts out of target/studio/cargo, which the Windows MSVC builds own.
export CARGO_HOME=/cache/cargo
export CARGO_TARGET_DIR=/cache/target
export npm_config_cache=/cache/npm

cd "$REPO"

echo "[container] app dependencies (adds the linux esbuild/tauri-cli binaries)"
npm install --no-audit --no-fund

echo "[container] building the installers ($BUNDLES; Rust release build + bundling)"
# tauri build runs prepare.mjs and the Vite build itself (beforeBuildCommand); the extension
# assets it copies (vscode-git-graph-rs/out/, vscode-git-graph-rs/media/) were compiled on
# the host by build-studio-linux.bat, into the submodule checkout mounted at
# /repo/vscode-git-graph-rs.
npx tauri build --bundles "$BUNDLES"

echo "[container] copying the bundles and binaries into the repository"
rm -rf "$REPO/target/studio/$OUT_DIR"
mkdir -p "$REPO/target/studio/$OUT_DIR" "$REPO/target/studio/cargo/release"
cp -r "$CARGO_TARGET_DIR/release/bundle/." "$REPO/target/studio/$OUT_DIR/"
# The release binary too, so scripts/measure.mjs (which gates sizes against
# target/studio/cargo/release) can run on the host once the container is done.
cp "$CARGO_TARGET_DIR/release/git-graph-studio" "$REPO/target/studio/cargo/release/"
# Everything above is written as root (the image defines no USER), so on the repository
# mount it lands root-owned and later host commands (a re-run of scripts/measure.mjs, or
# the next container pass) could not write into it. Hand the container-made directories
# back writable.
chmod -R a+rwX "$REPO/target/studio/$OUT_DIR" "$REPO/target/studio/cargo/release"

echo "[container] done:"
ls -l "$REPO/target/studio/$OUT_DIR"
