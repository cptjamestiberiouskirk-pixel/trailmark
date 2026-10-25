@echo off
rem Runs install-jb-watchdog.ps1 from this folder without changing the machine execution policy.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-jb-watchdog.ps1" %*
