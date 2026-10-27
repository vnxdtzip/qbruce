@echo off
REM ============================================================
REM  qBruce setup (Windows)
REM  Installs dependencies and launches the desktop app.
REM ============================================================
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Check the messages above.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting qBruce...
call npm start

endlocal
