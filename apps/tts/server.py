# Petit server pour servir les WAV générés

from http.server import SimpleHTTPRequestHandler, HTTPServer
import os

os.chdir(os.path.dirname(__file__))

server = HTTPServer(("0.0.0.0", 5002), SimpleHTTPRequestHandler)
print("[TTS FILE] Serveur de fichiers sur /out/")
server.serve_forever()
