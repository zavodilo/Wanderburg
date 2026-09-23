@echo off
rem ==========================================================================
rem  ArcEngine - editor launch (thin wrapper over the cross-platform CLI)
rem    editor.bat              -> port 8090 (or the next free one), opens browser
rem    editor.bat 9100         -> custom port
rem    editor.bat 9100 --no-open  -> do not open a browser
rem  Any OS: node tools/arc.mjs editor
rem ==========================================================================
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [x] Node.js not found in PATH. Install it from https://nodejs.org/
    echo.
    pause
    exit /b 1
)
node tools\arc.mjs editor %*
if errorlevel 1 (
    echo.
    echo   [x] The server exited with an error - see the message above.
    pause
)
endlocal
