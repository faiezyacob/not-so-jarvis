@echo off
title JARVIS Server
cd /d "%~dp0"
:loop
echo Starting JARVIS server...
call npm start
if %ERRORLEVEL% EQU 100 (
    echo Restarting JARVIS server...
    goto loop
)
echo JARVIS server has exited (code %ERRORLEVEL%).
pause