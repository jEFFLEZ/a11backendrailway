@echo off
setlocal
REM === Lanceur PROD A11 : prod web/cloud + LLM local + ngrok ===
cd /d "%~dp0"

set "ROOT_DIR=%~dp0"
set "FRONTEND_URL=https://a11.funesterie.pro"
set "API_URL=https://api.funesterie.pro"
set "HEALTH_URL=%API_URL%/health"

set "OPEN_BROWSER=1"
set "PAUSE_AT_END=1"
set "START_LLM=1"
set "START_NGROK=1"

set "LLM_EXE=%ROOT_DIR%..\a11llm\llm\server\llama-server.exe"
if not exist "%LLM_EXE%" set "LLM_EXE=%ROOT_DIR%..\..\a11llm\llm\server\llama-server.exe"
if not exist "%LLM_EXE%" set "LLM_EXE=D:\funesterie\a11\a11llm\llm\server\llama-server.exe"

set "MODEL=%ROOT_DIR%..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
if not exist "%MODEL%" set "MODEL=%ROOT_DIR%..\..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
if not exist "%MODEL%" set "MODEL=D:\funesterie\a11\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"

set "LLM_PORT=8080"

set "NGROK_EXE=%ROOT_DIR%..\..\Tools\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=%ROOT_DIR%..\..\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=D:\Tools\ngrok\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=D:\funesterie\a11\ngrok.exe"

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--check-only" (
  set "OPEN_BROWSER=0"
  set "START_LLM=0"
  set "START_NGROK=0"
)
if /I "%~1"=="--no-open" set "OPEN_BROWSER=0"
if /I "%~1"=="--no-pause" set "PAUSE_AT_END=0"
if /I "%~1"=="--no-llm" set "START_LLM=0"
if /I "%~1"=="--no-ngrok" set "START_NGROK=0"
shift
goto parse_args

:args_done
if /I "%A11_PROD_NO_OPEN%"=="1" set "OPEN_BROWSER=0"
if /I "%A11_PROD_NO_PAUSE%"=="1" set "PAUSE_AT_END=0"
if /I "%A11_PROD_NO_LLM%"=="1" set "START_LLM=0"
if /I "%A11_PROD_NO_NGROK%"=="1" set "START_NGROK=0"

echo [A11 PROD] Frontend : %FRONTEND_URL%
echo [A11 PROD] API      : %API_URL%
echo [A11 PROD] Health   : %HEALTH_URL%
echo [A11 PROD] LLM exe  : %LLM_EXE%
echo [A11 PROD] ngrok    : %NGROK_EXE%
echo.

where powershell >nul 2>nul
if errorlevel 1 goto skip_checks

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try {" ^
  "  $front = Invoke-WebRequest -Uri '%FRONTEND_URL%' -Method Head -UseBasicParsing;" ^
  "  Write-Host '[A11 PROD] Frontend OK :' $front.StatusCode;" ^
  "} catch {" ^
  "  Write-Host '[A11 PROD] Frontend ERR:' $_.Exception.Message;" ^
  "}" ^
  "try {" ^
  "  $health = Invoke-WebRequest -Uri '%HEALTH_URL%' -UseBasicParsing;" ^
  "  Write-Host '[A11 PROD] Health OK   :' $health.StatusCode $health.Content;" ^
  "} catch {" ^
  "  Write-Host '[A11 PROD] Health ERR  :' $_.Exception.Message;" ^
  "}"

:skip_checks
if "%START_LLM%"=="1" (
  if exist "%LLM_EXE%" (
    echo [A11 PROD] Lancement du LLM local...
    start "A11 PROD LLM" cmd /k """%LLM_EXE%"" -m ""%MODEL%"" --port %LLM_PORT% --host 127.0.0.1"
  ) else (
    echo [ERR] LLM non trouve : %LLM_EXE%
  )
) else (
  echo [A11 PROD] LLM local desactive.
)

if "%START_NGROK%"=="1" (
  if exist "%NGROK_EXE%" (
    echo [A11 PROD] Lancement de ngrok sur le port %LLM_PORT%...
    start "A11 PROD NGROK" cmd /k """%NGROK_EXE%"" http %LLM_PORT%"
  ) else (
    echo [ERR] ngrok non trouve : %NGROK_EXE%
  )
) else (
  echo [A11 PROD] ngrok desactive.
)

if "%OPEN_BROWSER%"=="1" (
  echo [A11 PROD] Ouverture du frontend en production...
  start "A11 PROD" "%FRONTEND_URL%"
) else (
  echo [A11 PROD] Mode check-only : ouverture navigateur desactivee.
)

echo.
echo [A11 PROD] Le frontend et l'API restent en prod, seuls LLM/ngrok tournent en local.
echo [A11 PROD] Utilisation :
echo   - normal        : double-clic sur ce fichier
echo   - check only    : start-prod-a11.bat --check-only
echo   - sans pause    : start-prod-a11.bat --no-pause
echo   - sans LLM      : start-prod-a11.bat --no-llm
echo   - sans ngrok    : start-prod-a11.bat --no-ngrok
echo   - scriptable    : start-prod-a11.bat --check-only --no-pause

if "%PAUSE_AT_END%"=="1" pause
endlocal
