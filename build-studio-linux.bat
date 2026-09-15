@echo off
setlocal
rem ============================================================================
rem  build-studio-linux.bat - build the Linux installers (.deb/.rpm/AppImage)
rem  of Git Graph Studio from Windows, in a Docker container.
rem
rem  Why a container and not the cross-compile build-rust.bat uses for the
rem  extension's .node engines: those are dependency-free C-ABI libraries that
rem  cargo-zigbuild can cross-link with zig's bundled glibc. The Tauri app
rem  links against webkit2gtk/GTK3 at build time and its deb/AppImage bundling
rem  must run in a real Linux userland - the same reason CI builds Studio on
rem  an ubuntu runner (native-build.yml). See scripts/Dockerfile.studio-linux.
rem
rem  Prerequisites: Docker Desktop running, plus node on the host (only for the
rem  extension assets the app embeds). First run builds the ~2 GB image and
rem  compiles ~500 crates; later runs are incremental (docker volume
rem  ggs-studio-linux-cache holds the cargo target and registry).
rem
rem  Output: target\studio\bundle-linux\
rem ============================================================================
rem Usage:
rem   build-studio-linux.bat          release build
rem   build-studio-linux.bat shell    drop into a shell in the build container

cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 goto :nodocker
docker info >nul 2>nul
if errorlevel 1 goto :dockeroff
where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/3] Preparing the plugin submodule assets the app embeds (host build)
if not exist plugin\package.json git submodule update --init plugin
if errorlevel 1 goto :fail
cd plugin
if not exist node_modules call npm install
if errorlevel 1 goto :fail
if not exist out\config.js call npm run compile
if errorlevel 1 goto :fail
if not exist media\out.min.js call npm run compile
if errorlevel 1 goto :fail
cd ..

echo [2/3] Building the Linux builder image (cached after the first run)
docker build -t ggs-linux-builder -f scripts\Dockerfile.studio-linux scripts
if errorlevel 1 goto :fail

if "%~1"=="shell" (
    docker run --rm -it -v "%cd%:/repo" -v ggs-studio-linux-cache:/cache ggs-linux-builder bash
    goto :end
)

echo [3/3] Building the Linux installers in the container
docker run --rm -v "%cd%:/repo" -v ggs-studio-linux-cache:/cache ggs-linux-builder bash /repo/scripts/studio-linux-build.sh
if errorlevel 1 goto :fail

echo.
echo Done. Installers are in target\studio\bundle-linux\
goto :end

:nodocker
echo [error] docker not found in PATH. Install Docker Desktop first.
exit /b 1

:dockeroff
echo [error] Docker is not running. Start Docker Desktop first.
exit /b 1

:nonode
echo [error] node not found in PATH. Install Node.js first.
exit /b 1

:fail
echo [error] Build failed.
exit /b 1

:end
endlocal
