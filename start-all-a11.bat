@echo off
REM === Script unique : lance TTS, LLM et ngrok ===
cd /d %~dp0


REM --- 1. Serveur TTS (Piper) ---
echo [A11] Lancement du serveur TTS...
set "TTS_MODEL_PATH=%~dp0apps\tts\fr_FR-siwis-medium.onnx"
start "TTS" cmd /k "cd /d %~dp0apps\tts && set TTS_MODEL_PATH=%TTS_MODEL_PATH% && python serve.py"

REM --- 2. LLM ---
set "LLM_EXE=D:\a11llm\llm\server\llama-server.exe"
set "MODEL=D:\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
set "LLM_PORT=8080"
if exist "%LLM_EXE%" (
    echo [A11] Lancement du LLM...
    start "LLM" cmd /k "\"%LLM_EXE%\" -m \"%MODEL%\" --port %LLM_PORT% --host 127.0.0.1"
) else (
    echo [WARN] LLM non trouvé : %LLM_EXE%
)

REM --- 3. ngrok ---
set "NGROK_EXE=D:\Tools\ngrok\ngrok.exe"
if exist "%NGROK_EXE%" (
    echo [A11] Lancement de ngrok sur le port %LLM_PORT%...
    start "NGROK" cmd /k "\"%NGROK_EXE%\" http %LLM_PORT%"
) else (
    echo [WARN] ngrok non trouvé : %NGROK_EXE%
)

echo.
echo [A11] Tous les services sont lancés (TTS, LLM, ngrok). Garder les fenêtres ouvertes.
pause
