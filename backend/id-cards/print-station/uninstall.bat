@echo off
rem Stops the print station and stops it starting with Windows.
call "%~dp0stop.bat"
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AMA Print Station.vbs" >nul 2>nul
echo The print station will no longer start with Windows.
pause
