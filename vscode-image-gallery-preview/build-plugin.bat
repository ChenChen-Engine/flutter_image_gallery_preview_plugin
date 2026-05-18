@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORKDIR=%~dp0"
cd /d "%WORKDIR%"

echo [build] packaging VSCode extension VSIX
call npm run package
exit /b %errorlevel%
