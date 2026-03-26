#!/bin/bash
set -e

PIPER_DIR="/app/piper"
PIPER_BIN="${PIPER_DIR}/piper"
PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
PIPER_ARCHIVE="/tmp/piper_linux_x86_64.tar.gz"
MAX_RETRIES=5
RETRY_DELAY=5

# Download Piper with retry logic if it isn't already present
if [ ! -f "${PIPER_BIN}" ]; then
    echo "[startup] Piper binary not found at ${PIPER_BIN} — downloading..."

    attempt=1
    while [ "${attempt}" -le "${MAX_RETRIES}" ]; do
        echo "[startup] Download attempt ${attempt}/${MAX_RETRIES}..."

        if wget --timeout=120 --tries=1 -q --show-progress \
                -O "${PIPER_ARCHIVE}" "${PIPER_URL}"; then
            echo "[startup] Download succeeded."
            break
        fi

        echo "[startup] Download failed (attempt ${attempt}/${MAX_RETRIES})."

        if [ "${attempt}" -eq "${MAX_RETRIES}" ]; then
            echo "[startup] ❌ All ${MAX_RETRIES} download attempts failed. Cannot start without Piper."
            exit 1
        fi

        echo "[startup] Retrying in ${RETRY_DELAY}s..."
        sleep "${RETRY_DELAY}"
        attempt=$((attempt + 1))
    done

    echo "[startup] Extracting Piper..."
    mkdir -p "${PIPER_DIR}"
    tar -xzf "${PIPER_ARCHIVE}" --strip-components=1 -C "${PIPER_DIR}"
    chmod +x "${PIPER_BIN}"
    rm -f "${PIPER_ARCHIVE}"
    echo "[startup] ✅ Piper installed at ${PIPER_BIN}"
else
    echo "[startup] ✅ Piper already present at ${PIPER_BIN} — skipping download."
fi

echo "[startup] Starting TTS server..."
exec python /app/serve.py
