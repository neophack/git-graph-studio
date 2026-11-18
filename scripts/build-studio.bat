@echo off
setlocal
rem Build Git Graph Studio (the Tauri app this repository is) plus its extension packages:
rem the app installer and the extension VSIXes the installer carries as resources (the
rem app installs them on first launch, like VS Code ships its bundled extensions). The
rem marketplace packages (git-graph-rs, claude-code) arrive from Open VSX via
rem scripts\prepare.mjs (step 2 below, scripts\fetch-marketplace-extensions.mjs);
rem claude-remote packs from its local source (extensions-src\claude-remote). The app
rem tree links no engine - every package arrives as its own self-contained VSIX.
rem Usage:
rem   scripts\build-studio.bat          release build, installers in target\studio\cargo\release\bundle
rem                                      packages in target\studio\bundled\app-resources\extensions\ (git-graph-rs.vsix, claude-remote.vsix)
rem   scripts\build-studio.bat dev      run the app in dev mode
rem   scripts\build-studio.bat debug    cargo debug build of the Tauri backend
rem
rem The release path is tuned for the LOCAL edit-compile loop (2026-11-18, the one-line
rem -change pass; docs/ci-speed-plan.md): a steady-state one-line Rust edit used to cost
rem 3m26s, of which the NSIS LZMA compression was ~80s, the second full prepare pass
rem ~15s and the vite passes ~35s even when the frontend never changed. The measures,
rem all local-only (cargo env overrides and a tauri --config merge — src-tauri/
rem Cargo.toml, tauri.conf.json, tauri dev, plain cargo and CI are untouched):
rem   - vite runs only when the frontend changed (scripts\vite-if-changed.mjs stamps
rem     the dist dir; a Rust-only edit skips both passes)
rem   - ONE prepare pass: tauri build's beforeBuildCommand is overridden (via the same
rem     merge file) to prepare-only, and this script no longer runs its own full pass
rem     ahead of it
rem   - NSIS compression none (the installer is ~2.5x larger and packs in seconds —
rem     fine for a local smoke build; CI's published installers keep LZMA)
rem   - LTO off + rust-lld (the release env overrides and the linker; the first build
rem     after this change recompiles the release tree once for the new fingerprints)

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

rem The installer packs the extension packages: the marketplace ones (Open VSX downloads,
rem scripts\fetch-marketplace-extensions.mjs) — git-graph-rs and claude-code ride in
rem every build (set GGS_BUNDLE_CLAUDE_CODE=0 to leave claude-code out of this build;
rem the Extensions view then installs it on demand) — plus
rem claude-remote, packed from its local source (extensions-src\claude-remote) into
rem every build (GGS_BUNDLE_CLAUDE_REMOTE=0 leaves it out; it needs no fetch and
rem packs offline too). A selected marketplace package the fetch cannot serve fails
rem this build (there is no local source for either). GGS_SKIP_MARKETPLACE_FETCH=1
rem builds offline without the marketplace pair - claude-remote still packs.
if not defined GGS_SKIP_MARKETPLACE_FETCH set GGS_REQUIRE_MARKETPLACE=1

rem The LOCAL speed diet for this script's release compiles (docs/ci-speed-plan.md):
rem no LTO and 16 codegen units instead of the size diet's fat LTO + one unit, which
rem cuts the main binary's, the ggs-node sidecar's and the GGS Remote daemon's release
rem builds to a fraction (the daemon's packer and tauri build inherit this
rem environment) at a larger exe. CI's published installers keep the size diet - these
rem are cargo's env overrides, so src-tauri/Cargo.toml is untouched and every other
rem build (tauri dev, plain cargo, CI) is unaffected. GGS_BUNDLE_GGS_REMOTE=0
rem skips the daemon release compile entirely for a quicker local iteration.
set CARGO_PROFILE_RELEASE_LTO=off
set CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
set CARGO_PROFILE_GGS_NODE_LTO=off
set CARGO_PROFILE_GGS_NODE_CODEGEN_UNITS=16

echo [1/3] Installing app dependencies
if not exist node_modules call npm install
if errorlevel 1 goto :fail

if "%~1"=="dev" goto :devmode
if "%~1"=="debug" goto :debugmode

echo [2/3] Building the frontend (skipped when it has not changed)
call node scripts\vite-if-changed.mjs
if errorlevel 1 goto :fail

echo [3/3] Building release installers (the extension packages ride along as resources)
rem rust-lld links the release binary markedly faster than MSVC's link.exe (CI's test
rem job measured it first); scoped to this release path because RUSTFLAGS churns every
rem profile's fingerprints — tauri dev and plain cargo keep link.exe and their caches.
set RUSTFLAGS=-Clinker=rust-lld
if not exist target\studio mkdir target\studio
call node -e "require('fs').writeFileSync('target/studio/build-local.json', JSON.stringify({build:{beforeBuildCommand:'node scripts/prepare.mjs --build'},bundle:{windows:{nsis:{compression:'none'}}}}, null, 2))"
if errorlevel 1 goto :fail
call npx tauri build --config target\studio\build-local.json
if errorlevel 1 goto :fail
echo.
echo Done. Installers are in target\studio\cargo\release\bundle\
echo       The extension packages: target\studio\bundled\app-resources\extensions\
echo       (anything this build left out is installable from the Extensions view)
goto :end

:devmode
echo [3/3] Launching tauri dev
call npx tauri dev
goto :end

:debugmode
echo [3/3] Building tauri backend in debug mode
cd src-tauri
cargo build
if errorlevel 1 goto :fail
echo Done. Binary: target\studio\cargo\debug\git-graph-studio.exe
goto :end

:nocargo
echo [error] cargo not found in PATH. Install Rust 1.82+ first.
exit /b 1

:nonode
echo [error] node not found in PATH. Install Node.js first.
exit /b 1

:fail
echo [error] Build failed.
exit /b 1

:end
endlocal
