@echo off
echo Starting ChatStandalone...
echo.
python start.py %1
if errorlevel 1 (
    echo.
    echo Python not found or error occurred.
    echo Try: npx serve -l 8080
    pause
)
