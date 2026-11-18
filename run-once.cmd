@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Local run: only sources that GitHub Actions cannot reach (127.0.0.1 / localhost).
rem Remote providers are scanned by the GitHub Actions workflow, so running them
rem here too would post every model twice.
set "TRACKER_CONFIG=config.local.json"

set "KEYDIR=%USERPROFILE%\.config\opencode"

for /f "usebackq delims=" %%k in ("%KEYDIR%\numes-api-key.txt") do set "NUMES_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\openrouter-api-key.txt") do set "OPENROUTER_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\zenmux-api-key.txt") do set "ZENMUX_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\crowllm-api-key.txt") do set "CROWLLM_KEY=%%k"
for /f "usebackq delims=" %%k in ("%KEYDIR%\apinex-api-key.txt") do set "APINEX_KEY=%%k"

if not exist "logs" mkdir "logs"

echo. >> "logs\scan.log"
echo ==== %DATE% %TIME% ==== >> "logs\scan.log"
node src\index.js --once --verbose >> "logs\scan.log" 2>&1
endlocal
