@echo off
setlocal
rem Builds the extension's VSIX independently of the app build. The package is the
rem extension's own standard build (vscode-git-graph-rs "npm run package" - the same VSIX
rem the VS Code Marketplace serves; the app carries no plugin code); this script reaches it
rem through prepare.mjs, which builds the engine host and the engine .node first.
rem
rem Usage:
rem   scripts\build-plugins.bat     builds git-graph-rs and packs its VSIX
rem
rem Output: target\studio\bundled\app-resources\extensions\git-graph-rs.vsix

rem The script lives in scripts\; everything else expects the repository root.
cd /d "%~dp0.."

where cargo >nul 2>nul
if errorlevel 1 goto :nocargo
where node >nul 2>nul
if errorlevel 1 goto :nonode

echo [1/1] Preparing target\studio - builds the engine host and the engine .node, then
echo       packs the standard VSIX via the extension's own build (prepare.mjs calls it)
if not exist node_modules call npm install
if errorlevel 1 goto :fail
call npm run prepare:assets
if errorlevel 1 goto :fail

echo.
echo Done. The extension package is in target\studio\bundled\app-resources\extensions\git-graph-rs.vsix
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
