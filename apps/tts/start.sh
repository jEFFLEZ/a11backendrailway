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

python serve.py
	python3 /app/apps/tts/serve.py &
	PIPER_PID=$!
	echo "[A11] Piper PID: ${PIPER_PID}"
else
	echo "[A11] ENABLE_PIPER_HTTP=false (Piper HTTP process not started)"
fi

cleanup() {
	if [ -n "${PIPER_PID}" ] && kill -0 "${PIPER_PID}" 2>/dev/null; then
		echo "[A11] Stopping Piper PID ${PIPER_PID}"
		kill "${PIPER_PID}" 2>/dev/null || true
	fi
}

trap cleanup EXIT INT TERM

node server.cjs