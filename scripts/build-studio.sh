#!/usr/bin/env bash
# Build Git Graph Studio (the Tauri app this repository is) plus its extension packages:
# the app installer and the marketplace extension VSIXes the installer carries as
# resources (the app installs them on first launch, like VS Code ships its bundled
# extensions) - scripts/prepare.mjs (step 2 below) fetches them from Open VSX
# (scripts/fetch-marketplace-extensions.mjs). The app tree carries no plugin code and
# links no engine - every package arrives as its own self-contained VSIX.
#
# The shell counterpart of scripts\build-studio.bat (Windows). NOT the Linux floor
# containers: a deb/rpm built here carries THIS machine's glibc, and the distributable
# packages must load on the ubuntu:22.04 / fedora:38 floors - those build through
# scripts/build-studio-linux.bat + scripts/docker/ (the container pass re-checks the
# floor; see scripts/docker/studio-linux-build.sh).
#
# Usage:
#   scripts/build-studio.sh          release build, installers in target/studio/cargo/release/bundle
#                                    packages in target/studio/bundled/app-resources/extensions/ (git-graph-rs.vsix)
#   scripts/build-studio.sh dev      run the app in dev mode
#   scripts/build-studio.sh debug    cargo debug build of the Tauri backend
set -euo pipefail
trap 'echo "[error] Build failed." >&2' ERR

# The script lives in scripts/; everything else expects the repository root.
cd "$(dirname "$0")/.."

command -v cargo >/dev/null 2>&1 || {
	echo "[error] cargo not found in PATH. Install Rust 1.94+ first."
	exit 1
}
command -v node >/dev/null 2>&1 || {
	echo "[error] node not found in PATH. Install Node.js first."
	exit 1
}

# The installer packs the marketplace extension packages (Open VSX downloads,
# scripts/fetch-marketplace-extensions.mjs): git-graph-rs rides in every build,
# claude-code does not (the Extensions view installs it from the marketplace on
# demand; set GGS_BUNDLE_CLAUDE_CODE=1 to pack it into this build). A selected
# package the fetch cannot serve fails this build (there is no local source for
# either). GGS_SKIP_MARKETPLACE_FETCH=1 builds fully offline without either.
if [ -z "${GGS_SKIP_MARKETPLACE_FETCH:-}" ]; then
	export GGS_REQUIRE_MARKETPLACE=1
fi

echo "[1/3] Installing app dependencies"
if [ ! -d node_modules ]; then
	npm install
fi

echo "[2/3] Preparing the app assets (target/studio)"
npm run prepare:assets

case "${1:-}" in
dev)
	echo "[3/3] Launching tauri dev"
	exec npx tauri dev
	;;
debug)
	echo "[3/3] Building tauri backend in debug mode"
	(cd src-tauri && cargo build)
	echo "Done. Binary: target/studio/cargo/debug/git-graph-studio"
	;;
*)
	echo "[3/3] Building release installers (the extension packages ride along as resources)"
	# Signing follows the environment, never the sources (scripts/signing.mjs): with the
	# Apple credentials exported, `tauri build` signs and notarizes; without them the
	# macOS build still gets its ad-hoc bundle seal — a bundle with no signature of its
	# own is assessed by Gatekeeper as damaged once the dmg is downloaded elsewhere
	# (the 0.1.5 bug), a sealed ad-hoc one merely as unverified.
	if [ "$(uname -s)" = Darwin ]; then
		node scripts/signing.mjs macos
		# Tauri's DMG step leaks scratch volumes when it fails (Finder holding the
		# mounted copy past the script's three detach retries); start clean.
		node scripts/recover-dmg.mjs --clean-only
		BUILD_START=$(date +%s)
		if ! npx tauri build --config target/studio/signing.json; then
			# The one flaky macOS failure is bundle_dmg.sh losing the detach race
			# (EBUSY) — recover the DMG ourselves instead of failing the build.
			node scripts/recover-dmg.mjs --since "$BUILD_START"
		fi
	else
		npx tauri build
	fi
	echo
	echo "Done. Installers are in target/studio/cargo/release/bundle/"
	echo "      The extension packages: target/studio/bundled/app-resources/extensions/"
	echo "      (anything this build left out is installable from the Extensions view)"
	if [ "$(uname -s)" = Linux ]; then
		echo "      Note: this deb/rpm carries this machine's glibc - for the distributable"
		echo "      floor-floor packages build through scripts/build-studio-linux.bat (Docker)."
	fi
	;;
esac
