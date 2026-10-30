@echo off
title SkyTide
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  SkyTide needs Node.js ^(free^). Opening the download page...
  echo  Install the LTS version, then double-click "Start SkyTide.bat" again.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)

echo.
echo  Starting SkyTide... your browser will open in a moment.
echo  Keep this window open while you use SkyTide. Close it to stop.
echo.

rem open the browser once the server has had a moment to start
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://localhost:8080'"
node server.js
pause
