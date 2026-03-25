@echo off
setlocal EnableExtensions EnableDelayedExpansion

echo [A11] START ALL

REM === PATH npm global (railway CLI) ===
set "PATH=C:\Users\cella\AppData\Roaming\npm;%PATH%"

REM === CONFIG ===
set "LLM_EXE=D:\a11llm\llm\server\llama-server.exe"
set "MODEL=D:\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
set "NGROK=D:\Tools\ngrok\ngrok.exe"
set "LLM_PORT=8080"

REM === Verifications rapides ===
if not exist "%LLM_EXE%" (
  echo [ERR] LLM introuvable: %LLM_EXE%
  pause
  exit /b 1
)

if not exist "%MODEL%" (
  echo [ERR] Model introuvable: %MODEL%
  pause
  exit /b 1
)

if not exist "%NGROK%" (
  echo [ERR] ngrok introuvable: %NGROK%
  pause
  exit /b 1
)

where railway >nul 2>nul
if errorlevel 1 (
  echo [ERR] Railway CLI introuvable.
  echo [HINT] npm i -g @railway/cli ^&^& railway login
  pause
  exit /b 1
)

REM === 1. Lancer LLM ===
echo [A11] Lancement LLM...
start "LLM" cmd /k ""%LLM_EXE%" -m "%MODEL%" --port %LLM_PORT% --host 127.0.0.1"

REM === Attente LLM ===
:wait_llm
timeout /t 2 >nul
curl -s "http://127.0.0.1:%LLM_PORT%" >nul 2>nul
if errorlevel 1 goto wait_llm

echo [A11] LLM OK

REM --- ngrok désactivé : section supprimée ---
set "NGROK_URL="
for /f "usebackq delims=" %%u in (`powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $r=Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels'; if($r -and $r.tunnels){ ($r.tunnels | Where-Object { $_.proto -eq 'https' } | Select-Object -First 1 -ExpandProperty public_url) }"`) do (
  set "NGROK_URL=%%u"
)
if not defined NGROK_URL goto wait_ngrok

echo [A11] URL: !NGROK_URL!

REM === 3. Sync Railway ===
echo [A11] Sync Railway...
call "%~dp0railway-sync-local-llm.bat"
if errorlevel 1 (
  echo [ERR] Echec du sync Railway.
  pause
  exit /b 1
)

echo.
echo [A11] READY
echo [INFO] Garder les fenetres LLM et NGROK ouvertes.
pause
exit /b 0