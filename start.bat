@echo off
title JARVIS Server
cd /d "%~dp0"

:check_node
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 goto run
where npm >nul 2>nul
if %ERRORLEVEL% EQU 0 goto run

echo.
echo Node.js was not found on this system, but JARVIS needs it to run.
echo.
set "JARVIS_INSTALL_NODE="
set /p "JARVIS_INSTALL_NODE=Download and install Node.js LTS now? [Y/N]: "
if /i not "%JARVIS_INSTALL_NODE%"=="Y" goto manual_install

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
if %ERRORLEVEL% NEQ 0 goto manual_install

set "PATH=%PATH%;%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%APPDATA%\npm"
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 goto manual_install

echo.
echo Node.js is ready.
echo.
goto run

:manual_install
echo.
echo Please install Node.js manually from https://nodejs.org/ (LTS), then run start.bat again.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:run
:loop
echo Starting JARVIS server...
call npm start
if %ERRORLEVEL% EQU 100 (
    echo Restarting JARVIS server...
    goto loop
)
echo JARVIS server has exited (code %ERRORLEVEL%).
pause
