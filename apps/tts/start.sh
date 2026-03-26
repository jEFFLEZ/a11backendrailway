#!/bin/bash
set -e

# Download Piper if not present
if [ ! -f "/usr/local/bin/piper" ]; then
    echo "Downloading Piper..."
    wget https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
    tar -xvf piper_linux_x86_64.tar.gz
    chmod +x piper
    mv piper/piper /usr/local/bin/piper
    rm piper_linux_x86_64.tar.gz
fi

# Lancer le serveur TTS principal



# Télécharger le modèle et son .json si absents dans apps/tts/ (R2 public URL)
MODEL_URL_BASE="https://pub-9513dd3bb30a4b14bbfa8ca518c7caf.r2.dev"
mkdir -p apps/tts

if [ ! -f "apps/tts/fr_FR-siwis-medium.onnx" ]; then
    echo "[TTS] Téléchargement du modèle .onnx..."
    wget -O apps/tts/fr_FR-siwis-medium.onnx "$MODEL_URL_BASE/fr_FR-siwis-medium.onnx"
    filetype=$(file apps/tts/fr_FR-siwis-medium.onnx)
    echo "[TTS] Type du fichier modèle: $filetype"
    if echo "$filetype" | grep -qi 'HTML'; then
        echo "[TTS][ERREUR] Le modèle téléchargé est une page HTML (URL incorrecte ou accès refusé)" >&2
        exit 1
    fi
fi
if [ ! -f "apps/tts/fr_FR-siwis-medium.onnx.json" ]; then
    echo "[TTS] Téléchargement du modèle .json..."
    wget -O apps/tts/fr_FR-siwis-medium.onnx.json "$MODEL_URL_BASE/fr_FR-siwis-medium.onnx.json"
    filetype=$(file apps/tts/fr_FR-siwis-medium.onnx.json)
    echo "[TTS] Type du fichier JSON: $filetype"
    if echo "$filetype" | grep -qi 'HTML'; then
        echo "[TTS][ERREUR] Le JSON téléchargé est une page HTML (URL incorrecte ou accès refusé)" >&2
        exit 1
    fi
fi

python3 siwis.py

# (optionnel) Lancer le backend Node après le TTS si besoin
# node server.cjs