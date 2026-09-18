@echo off
setlocal
rem ============================================================================
rem  build-studio-linux.bat - build the Linux installers of Git Graph Studio
rem  from Windows, in a Docker container.
rem
rem  Why a container and not the cross-compile build-rust.bat uses for the
rem  extension's .node engines: those are dependency-free C-ABI libraries that
rem  cargo-zigbuild can cross-link with zig's bundled glibc. The Tauri app
rem  links against webkit2gtk/GTK3 at build time and its deb/rpm bundling must
rem  run in a real Linux userland. CI builds the installers in these same
rem  floor containers (studio.yml); this script drives them locally from
rem  Windows. See scripts\docker\Dockerfile.studio-linux.
rem
rem  The container's base image IS the compatibility floor - the oldest distro
rem  that still has WebKitGTK 4.1, which Tauri 2 hard-requires (Ubuntu 20.04
rem  only ships the 4.0 API and can never run the app):
rem    default     ubuntu:22.04 -> deb, glibc 2.35: Ubuntu 22.04 up to 26.04,
rem                Debian 12/13, Mint 21+, Pop!_OS 22.04+
rem    rpm         fedora:38    -> rpm, glibc 2.37: Fedora 38+, openSUSE Leap
rem                15.6+ / Tumbleweed
rem
rem  Prerequisites: Docker Desktop running, plus node on the host (only for the
rem  extension assets the app embeds). First run builds the ~2 GB image and
rem  compiles ~500 crates; later runs are incremental (docker volume
rem  ggs-studio-linux-cache holds the cargo target and registry).
rem
rem  Output: target\studio\bundle-linux\ (deb) or target\studio\bundle-rpm\ (rpm)
rem ============================================================================
rem Usage:
rem   scripts\build-studio-linux.bat          deb installers (ubuntu:22.04 container)
rem   scripts\build-studio-linux.bat rpm      rpm installers (fedora:38 container)
rem   scripts\build-studio-linux.bat shell    drop into a shell in the default container

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

set "BASE=ubuntu:22.04"
set "TAG=ggs-linux-builder-deb"
set "BUNDLES=deb"
set "OUT_DIR=bundle-linux"
if "%~1"=="rpm" (
    set "BASE=fedora:38"
    set "TAG=ggs-linux-builder-rpm"
    set "BUNDLES=rpm"
    set "OUT_DIR=bundle-rpm"
)

where docker >nul 2>nul
if errorlevel 1 goto :nodocker
docker info >nul 2>nul
if errorlevel 1 goto :dockeroff
where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/3] Preparing the vscode-git-graph-rs submodule assets the app embeds (host build)
if not exist vscode-git-graph-rs\package.json git submodule update --init vscode-git-graph-rs
if errorlevel 1 goto :fail
cd vscode-git-graph-rs
if not exist node_modules call npm install
if errorlevel 1 goto :fail
if not exist out\config.js call npm run compile
if errorlevel 1 goto :fail
if not exist media\out.min.js call npm run compile
if errorlevel 1 goto :fail
cd ..

echo [2/3] Building the Linux builder image (cached after the first run)
docker build --build-arg BASE_IMAGE=%BASE% -t %TAG% -f scripts\docker\Dockerfile.studio-linux scripts\docker
if errorlevel 1 goto :fail

if "%~1"=="shell" (
    docker run --rm -it -v "%cd%:/repo" -v ggs-studio-linux-cache:/cache %TAG% bash
    goto :end
)

echo [3/3] Building the %BUNDLES% installers in the %BASE% container
docker run --rm -v "%cd%:/repo" -v ggs-studio-linux-cache:/cache -e BUNDLES=%BUNDLES% -e OUT_DIR=%OUT_DIR% %TAG% bash /repo/scripts/docker/studio-linux-build.sh
if errorlevel 1 goto :fail

echo.
echo Done. Installers are in target\studio\%OUT_DIR%\
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
