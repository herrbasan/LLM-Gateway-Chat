@echo off
REM Double-clickable wrapper for sync-ndb.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-ndb.ps1"
pause
