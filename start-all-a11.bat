@echo off
setlocal
goto :main

:check_port
set "%~2=0"
set "%~3="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%~1 .*LISTENING"') do (
    set "%~2=1"
    set "%~3=%%P"
    goto :eof
)
goto :eof

:main
REM === Script unique : lance backend, frontend, TTS, LLM et ngrok ===
cd /d "%~dp0"

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%apps\server"
set "TTS_DIR=%ROOT_DIR%apps\tts"
set "FRONTEND_DIR=%ROOT_DIR%..\a11frontendnetlify\apps\web"
set "BACKEND_PORT=3000"
set "TTS_PORT=5002"
set "LLM_PORT=8080"

echo [A11] Workspace backend  : %ROOT_DIR%
echo [A11] Workspace frontend : %FRONTEND_DIR%
echo.

REM --- 1. Backend Node ---
call :check_port %BACKEND_PORT% BACKEND_BUSY BACKEND_PID
if "%BACKEND_BUSY%"=="1" (
    echo [WARN] Backend deja actif sur le port %BACKEND_PORT% (PID %BACKEND_PID%). Lancement saute.
) else (
    if exist "%BACKEND_DIR%\package.json" (
        echo [A11] Lancement du backend sur le port %BACKEND_PORT%...
        start "A11 Backend" cmd /k "cd /d ""%BACKEND_DIR%"" && set PORT=%BACKEND_PORT% && set TTS_PORT=%TTS_PORT% && set TTS_BASE_URL=http://127.0.0.1:%TTS_PORT% && npm run dev"
    ) else (
        echo [ERR] Backend introuvable : %BACKEND_DIR%
    )
)

REM --- 2. Frontend Vite (repo separe) ---
if exist "%FRONTEND_DIR%\package.json" (
    echo [A11] Lancement du frontend...
    start "A11 Frontend" cmd /k "cd /d ""%FRONTEND_DIR%"" && npm run dev"
) else (
    echo [ERR] Frontend introuvable : %FRONTEND_DIR%
)

REM --- 3. Serveur TTS (Piper) ---
set "TTS_MODEL_PATH=%TTS_DIR%\fr_FR-siwis-medium.onnx"
set "TTS_PIPER_PATH=%TTS_DIR%\piper.exe"
set "TTS_ESPEAK_PATH=%TTS_DIR%\espeak-ng-data"
call :check_port %TTS_PORT% TTS_BUSY TTS_PID
if "%TTS_BUSY%"=="1" (
    echo [WARN] TTS deja actif sur le port %TTS_PORT% (PID %TTS_PID%). Lancement saute.
) else (
    if exist "%TTS_MODEL_PATH%" (
        echo [A11] Lancement du serveur TTS sur le port %TTS_PORT%...
        start "A11 TTS" cmd /k "cd /d ""%TTS_DIR%"" && set PORT=%TTS_PORT% && set MODEL_PATH=%TTS_MODEL_PATH% && set PIPER_PATH=%TTS_PIPER_PATH% && set ESPEAK_DATA_PATH=%TTS_ESPEAK_PATH% && set A11_AVATAR_UPDATE_URL=http://127.0.0.1:%BACKEND_PORT%/api/avatar/update && python siwis.py"
    ) else (
        echo [ERR] Modele TTS introuvable : %TTS_MODEL_PATH%
    )
)

REM --- 4. LLM ---
set "LLM_EXE=%ROOT_DIR%..\a11llm\llm\server\llama-server.exe"
if not exist "%LLM_EXE%" set "LLM_EXE=%ROOT_DIR%..\..\a11llm\llm\server\llama-server.exe"
if not exist "%LLM_EXE%" set "LLM_EXE=D:\funesterie\a11\a11llm\llm\server\llama-server.exe"
set "MODEL=%ROOT_DIR%..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
if not exist "%MODEL%" set "MODEL=%ROOT_DIR%..\..\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
if not exist "%MODEL%" set "MODEL=D:\funesterie\a11\a11llm\llm\models\Llama-3.2-3B-Instruct-Q4_K_M.gguf"
call :check_port %LLM_PORT% LLM_BUSY LLM_PID
if "%LLM_BUSY%"=="1" (
    echo [WARN] LLM deja actif sur le port %LLM_PORT% (PID %LLM_PID%). Lancement saute.
) else (
    if exist "%LLM_EXE%" (
        echo [A11] Lancement du LLM : %LLM_EXE%
        start "A11 LLM" cmd /k """%LLM_EXE%"" -m ""%MODEL%"" --port %LLM_PORT% --host 127.0.0.1"
    ) else (
        echo [ERR] LLM non trouve : %LLM_EXE%
    )
)

REM --- 5. ngrok ---
set "NGROK_EXE=%ROOT_DIR%..\..\Tools\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=%ROOT_DIR%..\..\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=D:\Tools\ngrok\ngrok.exe"
if not exist "%NGROK_EXE%" set "NGROK_EXE=D:\funesterie\a11\ngrok.exe"
if exist "%NGROK_EXE%" (
    echo [A11] Lancement de ngrok sur le port %LLM_PORT% : %NGROK_EXE%
    start "A11 NGROK" cmd /k """%NGROK_EXE%"" http %LLM_PORT%"
) else (
    echo [ERR] ngrok non trouve : %NGROK_EXE%
)

echo.
echo [A11] Les services ont ete demandes : backend, frontend, TTS, LLM, ngrok.
echo [A11] Garde les fenetres ouvertes pour laisser tourner les services.
pause
endlocal
goto :eof
