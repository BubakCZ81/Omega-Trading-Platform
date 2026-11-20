@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing project dependencies...
  call npm.cmd --prefix "%~dp0." install || (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Building unpacked Omega application...
call npm.cmd --prefix "%~dp0." run package:win -- --dir
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo Unpacked application created in release-omega\win-unpacked.
echo Run Omega from Omega.exe inside that folder.

rem To build the NSIS installer instead, uncomment this:
rem call npm.cmd --prefix "%~dp0." run package:win

pause