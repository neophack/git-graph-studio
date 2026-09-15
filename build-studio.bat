@echo off
setlocal
rem Build Git Graph Studio (the Tauri app this repository is)
rem Usage:
rem   build-studio.bat          release build, installers in target\studio\cargo\release\bundle
rem   build-studio.bat dev      run the app in dev mode
rem   build-studio.bat debug    cargo debug build of the Tauri backend

cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/4] Compiling the plugin submodule (the extension assets the app embeds)
if not exist plugin\package.json git submodule update --init plugin
if errorlevel 1 goto :fail
cd plugin
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

echo [4/4] Building release installers
call npx tauri build
if errorlevel 1 goto :fail
echo.
echo Done. Installers are in target\studio\cargo\release\bundle\
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
