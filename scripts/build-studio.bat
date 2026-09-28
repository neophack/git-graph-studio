@echo off
setlocal
rem Build Git Graph Studio (the Tauri app this repository is) plus its extension packages:
rem the app installer and the marketplace extension VSIXes the installer carries as
rem resources (the app installs them on first launch, like VS Code ships its bundled
rem extensions) - scripts\prepare.mjs (step 2 below) fetches them from Open VSX
rem (scripts\fetch-marketplace-extensions.mjs). The app tree carries no plugin code and
rem links no engine - every package arrives as its own self-contained VSIX.
rem Usage:
rem   scripts\build-studio.bat          release build, installers in target\studio\cargo\release\bundle
rem                                      packages in target\studio\bundled\app-resources\extensions\ (git-graph-rs.vsix)
rem   scripts\build-studio.bat dev      run the app in dev mode
rem   scripts\build-studio.bat debug    cargo debug build of the Tauri backend

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

rem The installer packs the marketplace extension packages (Open VSX downloads,
rem scripts\fetch-marketplace-extensions.mjs): git-graph-rs rides in every build,
rem claude-code does not (the Extensions view installs it from the marketplace on
rem demand; set GGS_BUNDLE_CLAUDE_CODE=1 to pack it into this build). A selected
rem package the fetch cannot serve fails this build (there is no local source for
rem either). GGS_SKIP_MARKETPLACE_FETCH=1 builds fully offline without either.
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
