@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0node_modules\electron\dist\electron.exe" goto run

echo.
echo   FastRelease is not installed yet.
echo   Please run this once in this folder:  npm install
echo.
pause
exit /b 1

:run
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
