#!/usr/bin/env bash
# The local mirror of what CI runs on this platform (.github/workflows/studio.yml's
# test-linux / test-macos jobs, plus the platform-neutral studio-test frontend job and
# the remote-daemon-test / remote-hub-test jobs). Run this before a push: if it passes
# here, the same commands pass in CI — same versions, same -D warnings, same
# GGS_PERF_FILES=20000 perf gate.
#
# Usage (always `bash <script>` — a .sh committed from Windows carries no executable
# bit, so direct invocation is never relied on):
#   bash scripts/test-studio.sh            everything: frontend, backend, daemon, hub
#   bash scripts/test-studio.sh --backend  the Rust half only (the container mode of
#                                          scripts\test-studio.bat drives this: the
#                                          repository mount's node_modules is a Windows
#                                          install the Linux container cannot use)
#
# The macOS residual: test-macos runs the same commands as test-linux, so a green run
# here covers everything but a cfg(target_os = "macos")-only path; there is no local
# answer for those from a Windows or Linux machine.
set -euo pipefail
trap 'echo "[error] A CI-parity check failed above." >&2' ERR

cd "$(dirname "$0")/.."

command -v cargo >/dev/null 2>&1 || {
	echo "[error] cargo not found in PATH. Install Rust 1.94+ first."
	exit 1
}
command -v node >/dev/null 2>&1 || {
	echo "[error] node not found in PATH. Install Node.js 20+ first."
	exit 1
}

BACKEND_ONLY=0
if [ "${1:-}" = "--backend" ]; then
	BACKEND_ONLY=1
elif [ -n "${1:-}" ]; then
	echo "usage: bash scripts/test-studio.sh [--backend]" >&2
	exit 2
fi

if [ "$BACKEND_ONLY" -eq 0 ]; then
	echo "[1/4] Frontend: typecheck, vitest, the remote workbench build"
	[ -d node_modules ] || npm install
	npm run typecheck
	npx vitest run
	npx vite build -c vite.remote.config.ts
else
	echo "[1/4] Frontend: skipped (--backend)"
fi

echo "[2/4] Backend: icons, then clippy -D warnings and the test suite (as CI runs them)"
node scripts/prepare.mjs --icons-only
export GGS_PERF_FILES=20000
(
	cd src-tauri
	# ggs-bash is the Windows-only sidecar; CI excludes it on this platform.
	cargo clippy --workspace --all-targets --all-features --exclude ggs-bash -- -D warnings
	cargo test --workspace --all-features --exclude ggs-bash
)

echo "[3/4] GGS Remote daemon: fmt, clippy, tests"
(
	cd extensions-src/ggs-remote/daemon
	cargo fmt --check
	cargo clippy --all-targets --target-dir ../../../target/studio/ggs-remote -- -D warnings
	cargo test --target-dir ../../../target/studio/ggs-remote
)

echo "[4/4] GGS Remote hub: fmt, clippy, tests (CI runs this suite on Linux alone)"
if [ "$(uname -s)" = Linux ]; then
	(
		cd extensions-src/ggs-remote/hub
		cargo fmt --check
		cargo clippy --all-targets --target-dir ../../../target/studio/ggs-remote-hub -- -D warnings
		cargo test --target-dir ../../../target/studio/ggs-remote-hub
	)
else
	echo "        skipped — not Linux (CI's hub job runs there only)"
fi

echo
echo "[ok] Every CI-parity check this platform runs passed."
