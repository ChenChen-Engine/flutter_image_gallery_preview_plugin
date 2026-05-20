@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "WORKDIR=%~dp0"
cd /d "%WORKDIR%"

set "COMMON_ARGS=buildPlugin copyPluginZipToOutput --no-daemon"
if exist "%WORKDIR%output" rmdir /s /q "%WORKDIR%output"
if exist "%WORKDIR%build\distributions" rmdir /s /q "%WORKDIR%build\distributions"
echo [build] using Gradle wrapper with Tencent mirror
call "%WORKDIR%gradlew.bat" %COMMON_ARGS%
exit /b %errorlevel%
