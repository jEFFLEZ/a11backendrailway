@echo off
REM Start Piper TTS server from D:\a11tts
cd /d "%~dp0"
echo [TTS] Lancement du serveur Piper sur port 5002...
python serve.py
pause
