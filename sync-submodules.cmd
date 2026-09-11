@echo off
REM Double-clickable wrapper for sync-submodules.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-submodules.ps1"
pause
