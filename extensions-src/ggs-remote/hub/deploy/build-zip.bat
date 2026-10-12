@echo off
setlocal
rem Builds the Hub's standalone Windows package (docs/ggs-remote-plan.md section 20.9): one
rem release build of ggs-remote-hub.exe staged with the example config and the README
rem under a versioned folder, zipped as ggs-remote-hub-<version>-windows-x64.zip - the
rem same layout release.yml's hub-packages job publishes, so a local zip and the
rem release zip differ only in version.
rem
rem   deploy\build-zip.bat            build then package
rem   set PREBUILT=<path to exe> & deploy\build-zip.bat   package a binary built elsewhere
rem   set VERSION=0.1.0 & deploy\build-zip.bat            override the version (CI passes the tag's)
rem
rem Needs cargo on PATH (Rust 1.94+) and Windows PowerShell 5+ for Compress-Archive.

set "here=%~dp0"
for %%i in ("%here%..") do set "hub=%%~fi"

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo

rem The version rides the first `version = "..."` line of Cargo.toml unless VERSION says
rem otherwise. cmd variable names are case-insensitive: the internal name must differ from
rem VERSION beyond case, or `set "ver="` would undefine the override before it is read.
set "hubver="
if defined VERSION set "hubver=%VERSION%"
for /f "tokens=2 delims== " %%a in ('findstr /b /c:"version" "%hub%\Cargo.toml"') do (
    if not defined hubver set "hubver=%%~a"
)
if not defined hubver goto :noversion

set "binary=%hub%\target\release\ggs-remote-hub.exe"
if defined PREBUILT set "binary=%PREBUILT%"
if not defined PREBUILT (
    cargo build --release --manifest-path "%hub%\Cargo.toml"
    if errorlevel 1 goto :fail
)
if not exist "%binary%" goto :nobinary

rem ---- the zip: the exe + the example config + the README, under a versioned folder ----
set "out=%hub%\target\packages"
set "stage=%out%\stage\ggs-remote-hub-%hubver%-windows-x64"
if exist "%stage%" rmdir /s /q "%stage%"
mkdir "%stage%"
if errorlevel 1 goto :fail
copy /y "%binary%" "%stage%\" >nul
if errorlevel 1 goto :fail
copy /y "%here%hub.example.toml" "%stage%\hub.toml.example" >nul
if errorlevel 1 goto :fail
copy /y "%hub%\README.md" "%stage%\" >nul
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%stage%' -DestinationPath '%out%\ggs-remote-hub-%hubver%-windows-x64.zip' -Force"
if errorlevel 1 goto :fail

echo package in %out%:
dir /b "%out%\ggs-remote-hub-%hubver%-windows-x64.zip"
goto :end

:nocargo
echo [error] cargo not found in PATH. Install Rust 1.94+ first.
exit /b 1

:noversion
echo [error] no version found in %hub%\Cargo.toml
exit /b 1

:nobinary
echo [error] no binary at %binary%
exit /b 1

:fail
echo [error] Build failed.
exit /b 1

:end
endlocal
