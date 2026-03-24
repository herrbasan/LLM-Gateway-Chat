@echo off
echo Starting ChatStandalone...
echo.
node server\server.js %1
if errorlevel 1 (
    echo.
    echo Node.js not found or error occurred.
    pause
)
