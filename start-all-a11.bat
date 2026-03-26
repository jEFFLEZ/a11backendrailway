@echo off
REM === Script unique : lance TTS, LLM et ngrok (auto-patch chemins) ===
cd /d %~dp0

REM --- 1. Serveur TTS (Piper) ---
echo [A11] Lancement du serveur TTS...
set "TTS_MODEL_PATH=%~dp0apps\tts\fr_FR-siwis-medium.onnx"
set "MODEL_URL=file:///%TTS_MODEL_PATH%"
if exist "%TTS_MODEL_PATH%" (
    start "TTS" cmd /k "cd /d %~dp0apps\tts && set MODEL_URL=%MODEL_URL% && set CONFIG_URL=%MODEL_URL%.json && python siwis.py"
) else (
    echo [ERR] Modèle TTS introuvable : %TTS_MODEL_PATH%"
)

REM --- 2. LLM ---
set "LLM_EXE=%~dp0..\a11llm\llm\server\llama-server.exe"
if not exist "%LLM_EXE%" set "LLM_EXE=%~dp0..\..\a11llm\llm\server\llama-server.exe"
if not exist "%LLM_EXE%" set "LLM_EXE=D:\funesterie\a11\a11llm\llm\server\llama-server.exe"
set "MODEL=%~dp0..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
if not exist "%MODEL%" set "MODEL=%~dp0..\..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
if not exist "%MODEL%" set "MODEL=D:\funesterie\a11\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
set "LLM_PORT=8080"
if exist "%LLM_EXE%" (
    echo [A11] Lancement du LLM : %LLM_EXE%
    start "LLM" cmd /k "%LLM_EXE% -m %MODEL% --port %LLM_PORT% --host 127.0.0.1"
) else (
    echo [ERR] LLM non trouvé : %LLM_EXE%"
)

REM --- 3. ngrok ---
set "NGROK_EXE=%~dp0..\..\Tools\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=%~dp0..\..\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=D:\Tools\ngrok\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=D:\funesterie\a11\ngrok.exe"
if exist "%NGROK_EXE%" (
    echo [A11] Lancement de ngrok sur le port %LLM_PORT% : %NGROK_EXE%
    start "NGROK" cmd /k "%NGROK_EXE% http %LLM_PORT%"
) else (
    echo [ERR] ngrok non trouvé : %NGROK_EXE%"
)

echo.
echo [A11] Tous les services sont lancés (TTS, LLM, ngrok). Garder les fenêtres ouvertes.
pause
