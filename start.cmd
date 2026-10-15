@echo off
rem Windows launcher: double-click to install and start the server.
rem All parameters are passed to start.ps1, for example:  start.cmd -Port 8080
rem (This file is intentionally ASCII-only so it renders in any console code page.)
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
echo.
echo Server stopped. Press any key to close this window...
pause >nul
