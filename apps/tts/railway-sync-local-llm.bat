@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Usage:
REM   railway-sync-local-llm.bat
REM   railway-sync-local-llm.bat my-service
REM Optional env vars:
REM   LLM_PORT=8080
REM   NGROK_BIN=C:\path\to\ngrok.exe
REM   RAILWAY_SERVICE=my-service
REM   RAILWAY_ENVIRONMENT=production

echo [SYNC] Verifications prealables...
echo [SYNC] Verification endpoint ngrok local...
echo [SYNC] Mise a jour Railway...
echo [SYNC] ngrok désactivé, plus de sync Railway.
call !RAILWAY_CMD!
if errorlevel 1 (
  echo [ERR] Echec de mise a jour de LOCAL_LLM_URL.
  echo [HINT] Verifie que tu es dans le bon projet Railway: railway status
  pause
  exit /b 1
)

echo [OK] LOCAL_LLM_URL mis a jour avec succes.
echo [INFO] Valeur poussee: !NGROK_URL!
echo.
echo [NEXT] Test rapide backend:
echo   curl -s https://api.funesterie.pro/health
echo   curl -s -X POST https://api.funesterie.pro/v1/chat/completions -H "Content-Type: application/json" -d "{\"provider\":\"local\",\"model\":\"llama\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"

pause
exit /b 0
