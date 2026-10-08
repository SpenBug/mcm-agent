@echo off
rem  Double-click entry for the license issuer UI.
rem  NOTE: keep this file ASCII-only. Non-ASCII in .bat gets mangled by cmd.
cd /d "%~dp0.."

where node >nul 2>nul
if not errorlevel 1 goto usenode

if exist "node_modules\electron\dist\electron.exe" goto useelectron

echo.
echo   Node.js not found.
echo   Install Node.js, or run this from inside the project folder.
echo.
pause
exit /b 1

:useelectron
rem  Electron ships its own Node - reuse it so no separate Node install is needed.
set ELECTRON_RUN_AS_NODE=1
"node_modules\electron\dist\electron.exe" tools\issuer.js
pause
exit /b

:usenode
node tools\issuer.js
pause
