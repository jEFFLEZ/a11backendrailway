import os
from http.server import BaseHTTPRequestHandler, HTTPServer

# --- Railway-compatible HTTP server ---
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'TTS service is running')

if __name__ == "__main__":
    try:
        port = int(os.environ.get("PORT", 8080))
        server = HTTPServer(("0.0.0.0", port), Handler)
        print(f"Server running on port {port}")
        server.serve_forever()
    except Exception as e:
        print("[TTS] ❌ Download failed:", e)
        raise SystemExit(1)

# --- CHECK .onnx.json CONFIG ---
MODEL_PATH_ENV = os.environ.get("MODEL_PATH")
try:
    MODEL_PATH = ensure_model()
    CONFIG_PATH = MODEL_PATH + ".json"
except Exception:
    CONFIG_PATH = MODEL_PATH_ENV + ".json" if MODEL_PATH_ENV else "(unknown)"
    print(f"[TTS] ❌ Fichier de configuration Piper manquant : {CONFIG_PATH}\nTélécharge le .onnx.json correspondant sur R2 !")
    raise SystemExit(1)

# --- CLEAN TEXT ---
def clean_text(text):
    import re
    text = re.sub(r'<\|.*?\|>', '', text)
    text = re.sub(r'[\*_~`|#>\[\]{}]', '', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

# --- SYNTH ---
def synthesize(text):
    text = clean_text(text)
    if not text:
        text = "Bonjour"

    fname = f"{uuid.uuid4().hex}.wav"
    out_path = os.path.join(OUT_DIR, fname)

    env = os.environ.copy()
    env["ESPEAK_DATA_PATH"] = ESPEAK_DATA

    cmd = [
        PIPER_EXE,
        "-m", MODEL_PATH,
        "--output_file", out_path,
    ]

    print("[TTS] ▶", text)

    result = subprocess.run(
        cmd,
        input=text.encode("utf-8"),
        capture_output=True,
        env=env
    )

    print("[TTS] stdout:", result.stdout.decode(errors="ignore"))
    print("[TTS] stderr:", result.stderr.decode(errors="ignore"))

    if result.returncode != 0:
        raise RuntimeError("Piper error")

    return fname

# --- SERVER ---
class Handler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print("[TTS]", format % args)

    def _send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        # HEALTH CHECK
        if parsed.path == "/health":
            self._send_json(200, {"ok": True})
            return

        # AUDIO FILE
        if parsed.path.startswith("/out/"):
            fname = os.path.basename(parsed.path)
            fpath = os.path.join(OUT_DIR, fname)

            if not os.path.exists(fpath):
                self.send_response(404)
                self.end_headers()
                return

            with open(fpath, "rb") as f:
                data = f.read()

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # TTS
        if parsed.path == "/api/tts":
            q = urllib.parse.parse_qs(parsed.query)
            text = q.get("text", [""])[0]

            try:
                fname = synthesize(text)
                host = self.headers.get("Host")

                self._send_json(200, {
                    "status": "ok",
                    "text": text,
                    "audio_url": f"https://{host}/out/{fname}"
                })

            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            data = json.loads(body)
            text = data.get("text", "")
        except:
            self._send_json(400, {"error": "invalid json"})
            return

        try:
            fname = synthesize(text)
            host = self.headers.get("Host")

            self._send_json(200, {
                "status": "ok",
                "text": text,
                "audio_url": f"https://{host}/out/{fname}"
            })

        except Exception as e:
            self._send_json(500, {"error": str(e)})

# --- RUN ---
def run():
    PORT = int(os.environ.get("PORT", 5002))
    print(f"[TTS] 🚀 Running on port {PORT}")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

if __name__ == "__main__":
    run()