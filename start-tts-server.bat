@echo off
REM Lance le serveur TTS (serve.py) dans le bon dossier
cd /d %~dp0
cd ..\apps\tts
python serve.py
pause