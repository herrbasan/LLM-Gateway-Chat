@echo off
echo Updating vendor libraries...
powershell -ExecutionPolicy Bypass -File "%~dp0update-vendor.ps1"
if errorlevel 1 (
    echo.
    echo Update failed!
    pause
)
