@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORKDIR=%~dp0"
cd /d "%WORKDIR%"

set "COMMON_ARGS=buildPlugin copyPluginZipToOutput --no-daemon"
echo [build] using Gradle wrapper with Tencent mirror
call "%WORKDIR%gradlew.bat" %COMMON_ARGS%
exit /b %errorlevel%
