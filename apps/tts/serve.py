# serve.py — Piper HTTP TTS server (Linux/Railway compatible)

from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.parse
import subprocess
import uuid
import os
import json
import threading
import time

_dir = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("TTS_MODEL_PATH", os.path.join(_dir, "fr_FR-siwis-medium.onnx"))
PIPER = os.environ.get("PIPER_BIN", "piper")
# On Railway: set TTS_OUT_DIR=/app/public/tts so Node's express.static serves the files at /tts/<name>
# Locally:   defaults to <serve.py dir>/out/ (served by serve.py itself at /out/<name>)
OUT_DIR = os.environ.get("TTS_OUT_DIR", os.path.join(_dir, "out"))
AUDIO_URL_PREFIX = os.environ.get("TTS_AUDIO_URL_PREFIX", "/tts")  # must match Node's static route
PORT = int(os.environ.get("PIPER_HTTP_PORT", "5002"))
TTL_SECONDS = 60 * 10  # 10 minutes

os.makedirs(OUT_DIR, exist_ok=True)

def cleanup_wav():
    while True:
        now = time.time()
        for fname in os.listdir(OUT_DIR):
            fpath = os.path.join(OUT_DIR, fname)
            if not fname.endswith(".wav"):
                continue
            try:
                mtime = os.path.getmtime(fpath)
                if now - mtime > TTL_SECONDS:
                    os.remove(fpath)
                    print("[CLEANUP] Deleted:", fpath)
            except Exception as e:
                print("[CLEANUP] Error deleting", fpath, e)
        time.sleep(60)

def synthesize(text):
    out_file = os.path.join(OUT_DIR, f"{uuid.uuid4()}.wav")
    cmd = [PIPER, "-m", MODEL, "--output_file", out_file]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    p.communicate(text.encode("utf-8"))
    if p.returncode != 0 or not os.path.exists(out_file):
        raise RuntimeError(f"piper exited with code {p.returncode}")
    return out_file

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print("[PIPER]", format % args)

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # Serve WAV files: GET /out/<filename>
        if parsed.path.startswith("/out/"):
            fname = os.path.basename(parsed.path)
            fpath = os.path.join(OUT_DIR, fname)
            if not os.path.exists(fpath) or not fname.endswith(".wav"):
                self.send_response(404)
                self.end_headers()
                return
            with open(fpath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # GET /api/tts?text=... (legacy compat)
        if parsed.path == "/api/tts":
            q = urllib.parse.parse_qs(parsed.query)
            text = q.get("text", [""])[0].strip()
            if not text:
                self._send_json(400, {"error": "missing text"})
                return
            try:
                out_file = synthesize(text)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
                return
            self._send_json(200, {
                "status": "ok",
                "text": text,
                "audio_url": f"/out/{os.path.basename(out_file)}"
            })
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/tts":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body)
            text = str(data.get("text", "")).strip()
        except Exception:
            self._send_json(400, {"error": "invalid JSON"})
            return

        if not text:
            self._send_json(400, {"error": "missing text"})
            return

        print("[PIPER] Texte reçu :", text)
        try:
            out_file = synthesize(text)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
            return

        # Return JSON with audio_url — Node.js requestRemoteTts picks up audio_url
        # and serves the file via its own express.static at /tts/<name>
        audio_url = f"{AUDIO_URL_PREFIX}/{os.path.basename(out_file)}"
        self._send_json(200, {
            "status": "ok",
            "text": text,
            "audio_url": audio_url
        })

def run():
    threading.Thread(target=cleanup_wav, daemon=True).start()
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[PIPER] Serveur TTS lancé sur http://0.0.0.0:{PORT}")
    print(f"[PIPER] Modèle : {MODEL}")
    print(f"[PIPER] Binaire : {PIPER}")
    server.serve_forever()

if __name__ == "__main__":
    run()
