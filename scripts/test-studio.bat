@echo off
setlocal
rem ============================================================================
rem  test-studio.bat - the local mirror of what CI runs, from Windows.
rem
rem  Why this exists: the CI failures that "passed locally" were all invisible on
rem  a Windows machine - #[cfg(windows)]-gated items that leave unused imports or
rem  unresolved names only on the Linux/macOS targets (2026-10-15: ggs-git's
rem  find_git_bash and the locate tests module broke every Linux and macOS job
rem  while the whole suite stayed green locally). This script runs, in order:
rem
rem    [1] the frontend job  - typecheck, vitest, the remote workbench build
rem    [2] the Windows backend job - icons, clippy -D warnings, the test suite
rem        (ggs-bash included, exactly as CI's test-windows runs it)
rem    [3] the Linux cfg gate - cargo clippy cross-checked against
rem        x86_64-unknown-linux-gnu for every crate whose dependency tree is pure
rem        Rust (the C-dependent ones - tree-sitter, ring - cannot cross-check
rem        without a Linux toolchain; step [5] covers them instead)
rem    [4] the GGS Remote daemon job (CI runs it on every OS)
rem    [5] with --linux: the FULL Linux backend suite (clippy + tests, the root
rem        app crate included) inside the ubuntu:22.04 floor container via Docker -
rem        the only true Linux parity available from a Windows machine. First run
rem        compiles the container's dependency graph; later runs are incremental
rem        (the ggs-studio-linux-cache volume holds them).
rem
rem  The remaining gap, stated honestly: macOS runs the same commands as Linux
rem  (step [5] covers their shared not-windows cfg paths), but a
rem  cfg(target_os = "macos")-only path has no local answer from this machine.
rem
rem  Usage:
rem    scripts\test-studio.bat           steps [1]-[4]
rem    scripts\test-studio.bat --linux   everything, the container pass included
rem ============================================================================

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 (
    echo [error] cargo not found in PATH. Install Rust 1.94+ first.
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    echo [error] node not found in PATH. Install Node.js 20+ first.
    exit /b 1
)

echo [1/5] Frontend: typecheck, vitest, the remote workbench build
rem Always reconcile — like CI's `npm ci || npm install`, never skipped: a node_modules
rem left stale by a dependency change made the old `if not exist node_modules` guard
rem skip the install and fail typecheck on packages the lockfile already carried.
call npm install
if errorlevel 1 exit /b 1
call npm run typecheck
if errorlevel 1 exit /b 1
call npx vitest run
if errorlevel 1 exit /b 1
call npx vite build -c vite.remote.config.ts
if errorlevel 1 exit /b 1

echo [2/5] Backend: icons, then clippy -D warnings and the test suite (as CI runs them)
call node scripts/prepare.mjs --icons-only
if errorlevel 1 exit /b 1
rem CI's test-windows runs the perf gate at 20,000 files; the local default is 5,000.
set GGS_PERF_FILES=20000
pushd src-tauri
cargo clippy --workspace --all-targets --all-features -- -D warnings
if errorlevel 1 (popd & exit /b 1)
cargo test --workspace --all-features
if errorlevel 1 (popd & exit /b 1)
popd

echo [3/5] Linux cfg gate: cross-clippy the pure-Rust crates for x86_64-unknown-linux-gnu
rem The list is the workspace's crates whose dependency trees need no C toolchain
rem (ggs-analysis, ggs-ext, ggs-index, ggs-mcp, ggs-providers, ggs-node carry
rem tree-sitter or ring; ggs-bash is Windows-only; the root app crate links GTK).
rem Keep the list in sync with the membership when a pure crate joins: the compiler
rem fails loudly on an unknown -p name, so drift is caught on the next run.
rustup target add x86_64-unknown-linux-gnu
if errorlevel 1 exit /b 1
pushd src-tauri
cargo clippy --all-targets --target x86_64-unknown-linux-gnu -p ggs-base -p ggs-can -p ggs-codec -p ggs-config -p ggs-fs -p ggs-git -p ggs-proto -p ggs-remote-proto -p ggs-shellenv -p ggs-testkit -p ggs-text -- -D warnings
if errorlevel 1 (popd & exit /b 1)
popd

echo [4/5] GGS Remote daemon: fmt, clippy, tests
pushd extensions-src\ggs-remote\daemon
cargo fmt --check
if errorlevel 1 (popd & exit /b 1)
cargo clippy --all-targets --target-dir ..\..\..\target\studio\ggs-remote -- -D warnings
if errorlevel 1 (popd & exit /b 1)
cargo test --target-dir ..\..\..\target\studio\ggs-remote
if errorlevel 1 (popd & exit /b 1)
popd

if not "%~1"=="--linux" (
    echo.
    echo [ok] Steps [1]-[4] passed. Run "scripts\test-studio.bat --linux" for the full
    echo       Linux backend parity pass ^(Docker^), or nothing more is needed from this machine.
    exit /b 0
)

echo [5/5] Full Linux backend suite in the ubuntu:22.04 floor container
where docker >nul 2>nul
if errorlevel 1 (
    echo [error] docker not found in PATH. Install Docker Desktop, or accept the gap.
    exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
    echo [error] Docker is not running. Start Docker Desktop first.
    exit /b 1
)
docker build --build-arg BASE_IMAGE=ubuntu:22.04 -t ggs-linux-builder-deb -f scripts\docker\Dockerfile.studio-linux scripts\docker
if errorlevel 1 exit /b 1
rem The cache volume and env overrides mirror scripts\build-studio-linux.bat: the
rem compile lands on the volume (not the slow repository mount), RUSTUP_TOOLCHAIN
rem rides the image's own stable, and CARGO_TARGET_DIR's debug/ keeps clear of the
rem release/ the installer builds own.
docker run --rm -v "%cd%:/repo" -v ggs-studio-linux-cache:/cache -e CARGO_HOME=/cache/cargo -e CARGO_TARGET_DIR=/cache/target -e RUSTUP_TOOLCHAIN=stable ggs-linux-builder-deb bash /repo/scripts/test-studio.sh --backend
if errorlevel 1 exit /b 1

echo.
echo [ok] Every CI-parity check passed - frontend, Windows backend, the Linux cfg
echo       gate, the daemon, and the full Linux backend suite.
endlocal
