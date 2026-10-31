@echo off
rem PowerShell by full path: cmd.exe looks in the current folder first, so a
rem powershell.exe there would otherwise run instead.
rem Runs install.ps1 from this folder without changing the machine execution policy.
rem Options pass through, for example: install.cmd -Codex -Watchdog
rem Started from PowerShell 7, Windows PowerShell would inherit its module
rem path and fail to load its own modules; cleared, it uses its default.
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
