#!/usr/bin/env bash
# The in-container half of the Linux installer build, driven by scripts/build-studio-linux.bat
# (local builds from Windows) and by CI's studio-linux job (.github/workflows/studio.yml):
# the container's base image IS the compatibility floor, so this pass also verifies the
# binary never asks for a newer glibc than that floor (the floor guard at the end). Runs
# inside the ggs-linux-builder image (scripts/docker/Dockerfile.studio-linux) with the
# repository mounted at /repo and a cache volume at /cache. Keep this file LF-only: the
# container's bash cannot read CRLF (enforced by .gitattributes).
set -euo pipefail

: "${REPO:=/repo}"
# What tauri build bundles, where the installers land under target/studio/ and the glibc
# floor the pass enforces - all set by the caller so the same image serves the deb pass
# (ubuntu:22.04 base, floor 2.35) and the rpm pass (fedora:38 base, floor 2.37); an empty
# GLIBC_FLOOR falls back to the default that matches BUNDLES.
: "${BUNDLES:=deb}"
: "${OUT_DIR:=bundle-linux}"
: "${GLIBC_FLOOR:=}"
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
# The release binary too (ggs, since mainBinaryName renamed the artifact), so
# scripts/measure.mjs can run its sizes and probes on the host against
# target/studio/cargo/release once the container is done.
cp "$CARGO_TARGET_DIR/release/ggs" "$REPO/target/studio/cargo/release/"
# Everything above is written as root (the image defines no USER), so on the repository
# mount it lands root-owned and later host commands (a re-run of scripts/measure.mjs, or
# the next container pass) could not write into it. Hand the container-made directories
# back writable.
chmod -R a+rwX "$REPO/target/studio/$OUT_DIR" "$REPO/target/studio/cargo/release"

# The floor guard: linking against the base image's glibc cannot produce a newer version
# requirement, so a violation means this pass ran against a newer userland than its floor
# - exactly how 0.1.2's deb came to require glibc 2.39 (built natively on ubuntu-24.04,
# where Rust std's weak pidfd_spawn / pidfd_getpid references became hard GLIBC_2.39
# version entries that Ubuntu 22.04's loader refuses). Fail here instead of shipping a
# package no floor distro can load.
floor="${GLIBC_FLOOR:-$([ "$BUNDLES" = rpm ] && echo 2.37 || echo 2.35)}"
floor_minor="${floor#2.}"
max_minor="$(readelf --version-info "$CARGO_TARGET_DIR/release/ggs" \
	| grep -oE 'GLIBC_2\.[0-9]+' | grep -oE '[0-9]+$' | sort -n | tail -n 1 || true)"
if [ -n "$max_minor" ] && [ "$max_minor" -gt "$floor_minor" ]; then
	echo "[container] error: the binary requires glibc 2.$max_minor, above this image's $floor floor" >&2
	exit 1
fi
echo "[container] glibc floor check passed: highest requirement 2.${max_minor:-none}, floor $floor"

echo "[container] done:"
ls -l "$REPO/target/studio/$OUT_DIR"
