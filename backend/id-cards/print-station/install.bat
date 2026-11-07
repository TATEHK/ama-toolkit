@echo off
setlocal
cd /d "%~dp0"
title AMA print station setup

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist config.json (
  echo config.json is missing. Copy config.example.json to config.json, fill it in, then run this again.
  pause
  exit /b 1
)

echo Installing...
call npm install --omit=dev
if errorlevel 1 (
  echo Install failed. Check your internet connection and try again.
  pause
  exit /b 1
)

echo.
echo Checking sign in and printer...
node agent.js --test
if errorlevel 1 (
  echo.
  echo The check failed. Read the message above, fix config.json, then run this again.
  pause
  exit /b 1
)

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
> "%STARTUP%\AMA Print Station.vbs" echo CreateObject("WScript.Shell").Run """%~dp0start-hidden.vbs""", 0, False

call stop.bat >nul 2>nul
start "" wscript.exe "%~dp0start-hidden.vbs"

echo.
echo Done. The print station is running and will start by itself whenever you log in to Windows.
echo Its activity is written to agent.log in this folder.
pause
