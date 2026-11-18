@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "KEYDIR=%USERPROFILE%\.config\opencode"

for /f "usebackq delims=" %%k in ("%KEYDIR%\numes-api-key.txt") do set "NUMES_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\zenmux-api-key.txt") do set "ZENMUX_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\crowllm-api-key.txt") do set "CROWLLM_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\apinex-api-key.txt") do set "APINEX_KEY=%%k"

if not exist "logs" mkdir "logs"

echo. >> "logs\scan.log"
echo ==== %DATE% %TIME% ==== >> "logs\scan.log"
node src\index.js --once --verbose >> "logs\scan.log" 2>&1
endlocal
