@echo off
rem Двойной щелчок по этому файлу запускает установку и сервер на Windows.
rem Все параметры передаются в start.ps1, например:  start.cmd -Port 8080
chcp 65001 >nul
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
echo.
echo Сервер остановлен. Нажмите любую клавишу, чтобы закрыть окно...
pause >nul
