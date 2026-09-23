@echo off
rem ==========================================================================
rem  ArcEngine - local launch (thin wrapper over the cross-platform CLI)
rem    run.bat              -> port 8080 (or the next free one), opens browser
rem    run.bat 9000         -> port 9000
rem    run.bat 9000 --no-open  -> do not open a browser
rem  Any OS: node tools/arc.mjs run
rem ==========================================================================
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [x] Node.js not found in PATH.
    echo       Install it from https://nodejs.org/ ^(LTS^) and run this file again.
    echo.
    pause
    exit /b 1
)
node tools\arc.mjs run %*
if errorlevel 1 (
    echo.
    echo   [x] The server exited with an error - see the message above.
    pause
)
endlocal
