@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1" %*
set "KITCHEN_EXIT=%ERRORLEVEL%"
popd
if not "%KITCHEN_EXIT%"=="0" if not "%OUR_KITCHEN_NO_PAUSE%"=="1" pause
exit /b %KITCHEN_EXIT%
