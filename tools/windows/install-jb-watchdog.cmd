@echo off
rem PowerShell by full path: cmd.exe looks in the current folder first, so a
rem powershell.exe there would otherwise run instead.
rem Runs install-jb-watchdog.ps1 from this folder without changing the machine execution policy.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-jb-watchdog.ps1" %*
