@echo off
REM Double-clickable wrapper for sync-vendor.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-vendor.ps1"
pause
