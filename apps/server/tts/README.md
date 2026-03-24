# TTS Models

Place Piper ONNX model files in this folder for local spawn mode and Railway deployment.

Recommended file:
- `fr_FR-siwis-medium.onnx`

Recommended production env:
- `TTS_MODEL_PATH=/app/apps/server/tts/fr_FR-siwis-medium.onnx`

Notes:
- Keep large model files out of Git if they exceed repository limits.
- If you store models externally, set `TTS_MODEL_PATH` to the mounted absolute path.
