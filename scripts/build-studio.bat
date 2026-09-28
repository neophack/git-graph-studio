@echo off
setlocal
rem Build Git Graph Studio (the Tauri app this repository is) plus its extension package:
rem the app installer and the git-graph-rs VSIX the installer carries as a resource (the app
rem installs that package on first launch, like VS Code ships its bundled extensions). The
rem engine host links nothing - it loads the package's git-graph.node over its C ABI -
rem never into the app itself - and rides inside the VSIX as its engine .node;
rem scripts\prepare.mjs (step 3 below) builds that binary and packs it in. To build every
rem plugin's VSIX on its own, without the app installer, use scripts\build-plugins.bat instead.
rem Usage:
rem   scripts\build-studio.bat          release build, installers in target\studio\cargo\release\bundle
rem                                      plugin package in target\studio\bundled\app-resources\extensions\ (git-graph-rs.vsix)
rem   scripts\build-studio.bat dev      run the app in dev mode
rem   scripts\build-studio.bat debug    cargo debug build of the Tauri backend

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

rem The installer packs the marketplace extension packages (Open VSX downloads,
rem scripts\fetch-marketplace-extensions.mjs) - both by default: git-graph-rs downgrades
rem to the locally packed VSIX when the registry is unreachable, claude-code fails the
rem build. Set GGS_BUNDLE_CLAUDE_CODE=0 to leave claude-code out of this build, or
rem GGS_SKIP_MARKETPLACE_FETCH=1 to build fully offline without it.
if not defined GGS_SKIP_MARKETPLACE_FETCH set GGS_REQUIRE_MARKETPLACE=1

echo [1/4] Compiling the vscode-git-graph-rs submodule (the extension assets the app embeds)
if not exist vscode-git-graph-rs\package.json git submodule update --init vscode-git-graph-rs
if errorlevel 1 goto :fail
cd vscode-git-graph-rs
if not exist node_modules call npm install
if errorlevel 1 goto :fail
call npm run compile
if errorlevel 1 goto :fail
cd ..

echo [2/4] Installing app dependencies
if not exist node_modules call npm install
if errorlevel 1 goto :fail

echo [3/4] Preparing the app assets (target\studio)
call npm run prepare:assets
if errorlevel 1 goto :fail

if "%~1"=="dev" goto :devmode
if "%~1"=="debug" goto :debugmode

echo [4/4] Building release installers (the git-graph-rs VSIX rides along as a resource)
call npx tauri build
if errorlevel 1 goto :fail
echo.
echo Done. Installers are in target\studio\cargo\release\bundle\
echo       The git-graph-rs plugin package: target\studio\bundled\app-resources\extensions\git-graph-rs.vsix
echo       (also installable by hand from the Extensions view)
goto :end

:devmode
echo [4/4] Launching tauri dev
call npx tauri dev
goto :end

:debugmode
echo [4/4] Building tauri backend in debug mode
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
