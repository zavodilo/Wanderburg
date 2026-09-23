@echo off
rem ==========================================================================
rem  ArcEngine - code check (thin wrapper over the cross-platform CLI)
rem    check.bat            -> fast profile: types, tests, skills sync, manifest
rem    check.bat --all      -> release gate (+ headless render/visual)
rem  Any OS: node tools/arc.mjs check
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
node tools\arc.mjs check %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
