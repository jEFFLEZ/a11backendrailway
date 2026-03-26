#!/bin/bash
set -e

# Download Piper if not present
if [ ! -f "/usr/local/bin/piper" ]; then
    echo "Downloading Piper..."
    wget https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
    tar -xvf piper_linux_x86_64.tar.gz
    chmod +x piper
    mv piper /usr/local/bin/piper
    rm piper_linux_x86_64.tar.gz
fi

# Lancer le serveur TTS principal
python3 siwis.py

# (optionnel) Lancer le backend Node après le TTS si besoin
# node server.cjs