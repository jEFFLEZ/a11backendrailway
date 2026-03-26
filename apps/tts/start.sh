#!/bin/bash
set -e

# Ensure espeak-ng is installed (for Railway Ubuntu/Debian containers)
if ! command -v espeak-ng >/dev/null 2>&1; then
    echo "[TTS] Installing espeak-ng..."
    apt-get update && apt-get install -y espeak-ng
fi

# Download Piper if not present
if [ ! -f "/usr/local/bin/piper" ]; then
        echo "Downloading Piper..."
        wget https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
        tar -xvf piper_linux_x86_64.tar.gz
        chmod +x piper
        mv piper/piper /usr/local/bin/piper
fi

# Start the TTS Python server
python3 ./apps/tts/siwis.py
    rm piper_linux_x86_64.tar.gz
fi

# Lancer le serveur TTS principal



# Télécharger le modèle et son .json si absents dans apps/tts/ (R2 public URL)
MODEL_URL_BASE="https://files.funesterie.me"
mkdir -p apps/tts

if [ ! -f "apps/tts/fr_FR-siwis-medium.onnx" ]; then
    wget -O apps/tts/fr_FR-siwis-medium.onnx "$MODEL_URL_BASE/fr_FR-siwis-medium.onnx"
fi

if [ ! -f "apps/tts/fr_FR-siwis-medium.onnx.json" ]; then
    wget -O apps/tts/fr_FR-siwis-medium.onnx.json "$MODEL_URL_BASE/fr_FR-siwis-medium.onnx.json"
fi

python siwis.py

# (optionnel) Lancer le backend Node après le TTS si besoin
# node server.cjs