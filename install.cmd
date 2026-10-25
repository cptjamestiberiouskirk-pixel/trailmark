@echo off
rem Runs install.ps1 from this folder without changing the machine execution policy.
rem Options pass through, for example: install.cmd -Codex -Watchdog
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
