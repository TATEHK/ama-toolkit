@echo off
rem Stops the AMA print station if it is running.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*agent.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
cd /d "%~dp0"
node agent.js --mark-offline >nul 2>nul
echo Print station stopped.
