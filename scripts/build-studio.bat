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

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

rem The installer packs the extension packages: the marketplace ones (Open VSX downloads,
rem scripts\fetch-marketplace-extensions.mjs) — git-graph-rs rides in every build,
rem claude-code does not (the Extensions view installs it from the marketplace on
rem demand; set GGS_BUNDLE_CLAUDE_CODE=1 to pack it into this build) — plus
rem claude-remote, packed from its local source (extensions-src\claude-remote) into
rem every build (GGS_BUNDLE_CLAUDE_REMOTE=0 leaves it out; it needs no fetch and
rem packs offline too). A selected marketplace package the fetch cannot serve fails
rem this build (there is no local source for either). GGS_SKIP_MARKETPLACE_FETCH=1
rem builds offline without the marketplace pair - claude-remote still packs.
if not defined GGS_SKIP_MARKETPLACE_FETCH set GGS_REQUIRE_MARKETPLACE=1

echo [1/3] Installing app dependencies
if not exist node_modules call npm install
if errorlevel 1 goto :fail

echo [2/3] Preparing the app assets (target\studio)
call npm run prepare:assets
if errorlevel 1 goto :fail

if "%~1"=="dev" goto :devmode
if "%~1"=="debug" goto :debugmode

echo [3/3] Building release installers (the extension packages ride along as resources)
call npx tauri build
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
