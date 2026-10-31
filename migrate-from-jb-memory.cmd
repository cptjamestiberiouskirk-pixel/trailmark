@echo off
rem Moves an install of jb-memory (Trailmark before 0.5.0) to Trailmark, for
rem Claude Code and Codex. PowerShell by full path: cmd.exe looks in the
rem current folder first, so a powershell.exe there would otherwise run.
rem Options pass through, for example: migrate-from-jb-memory.cmd --dry-run
rem Started from PowerShell 7, Windows PowerShell would inherit its module
rem path and fail to load its own modules; cleared, it uses its default.
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\migrate-from-jb-memory.ps1" %*
echo.
pause
