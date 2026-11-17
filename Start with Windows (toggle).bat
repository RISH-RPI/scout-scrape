@echo off
rem Toggles a launcher in your Startup folder so the scraper (and its daily auto-run) starts when you log in.
set "LAUNCHER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Scout Scraper.bat"
if exist "%LAUNCHER%" goto off

> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo cd /d "%~dp0"
>> "%LAUNCHER%" echo start "Scout Scraper" /min node server.js
echo ON: Scout Scraper will start (minimized) every time you log in to Windows.
echo Run this file again to turn it off.
pause
exit /b 0

:off
del "%LAUNCHER%"
echo OFF: Scout Scraper will no longer start with Windows.
pause
