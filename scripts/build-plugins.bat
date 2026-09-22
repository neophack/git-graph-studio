@echo off
setlocal
rem Builds every .ggx plugin under plugins/ independently of the app build: each plugin's own
rem Cargo [[bin]] (src-tauri/Cargo.toml), then its own packer. `ggs` (this script, and
rem scripts/prepare.mjs) never reaches into a plugin's sources directly - git-graph-rs's
rem packer (plugins/git-graph-rs/build.mjs) is the only thing that reads the
rem vscode-git-graph-rs submodule; this script only calls it. Needs the app's own webview
rem assets prepared first (git-graph-rs's packer reads target\studio\public\gitgraph\, which
rem only scripts\prepare.mjs assembles), so this script runs that too.
rem
rem Usage:
rem   scripts\build-plugins.bat     builds git-graph-rs + ggs-ext-demo, packs both .ggx
rem
rem Output: target\studio\bundled\git-graph-rs-<version>.ggx
rem         target\studio\bundled\ggs-ext-demo-<version>.ggx

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/3] Preparing the app's webview assets (target\studio) - also builds plugins\git-graph-rs
echo       and packs it (scripts\prepare.mjs does both, via plugins\git-graph-rs\build.mjs)
if not exist node_modules call npm install
if errorlevel 1 goto :fail
call npm run prepare:assets
if errorlevel 1 goto :fail

echo [2/3] Building plugins\ggs-ext-demo
cd src-tauri
cargo build --release --bin ggs-ext-demo
if errorlevel 1 goto :fail
cd ..

echo [3/3] Packing plugins\ggs-ext-demo\ into ggs-ext-demo.ggx
node scripts\build-ggx-demo.mjs --bin target\studio\cargo\release\ggs-ext-demo.exe
if errorlevel 1 goto :fail

echo.
echo Done. Plugin packages are in target\studio\bundled\
echo       git-graph-rs-*.ggx   (plugins\git-graph-rs\, packed via prepare.mjs)
echo       ggs-ext-demo-*.ggx   (plugins\ggs-ext-demo\)
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
