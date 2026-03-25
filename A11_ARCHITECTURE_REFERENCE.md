# A11 Architecture Reference

## Goal
Build a modular AI system with:
- local LLM (GGUF)
- local TTS (voice)
- central backend router (A11)
- frontend interface

## Project Structure

D:/A11
- llm/: text generation stack (GGUF / llama.cpp)
- tts/: speech synthesis stack
- backend/: A11 API (Railway)
- frontend/: UI app (Netlify)

## 1) LLM Layer (llm)

Role:
- Generate text responses.

Typical content:
- models/: .gguf files
- server/: llama.cpp server binaries
- start script

Typical endpoint:
- http://localhost:8080/completion

Notes:
- GGUF quantization Q4 is a practical default.
- CPU mode is acceptable.
- External access must use a secure tunnel (ngrok or Cloudflare Tunnel).

## 2) TTS Layer (tts)

Role:
- Convert text to audio.

Typical content:
- models/: voice models
- server/: TTS engine runtime (for example Piper)
- start script

Typical endpoint:
- http://localhost:5002/tts

Notes:
- Must remain independent from the LLM process.
- Usually called after text completion.

## 3) Backend Layer (A11 on Railway)

Role:
- Intelligent routing between providers:
  - cloud provider (OpenAI)
  - local LLM (GGUF through tunnel)
  - optional additional providers

Key variables:
- LOCAL_LLM_URL=https://xxxx.ngrok-free.app
- OPENAI_API_KEY=...
- TTS_BASE_URL=... (optional, for externalized TTS)

Routing behavior:
- if provider=local, call GGUF/local route
- otherwise use cloud provider route

## 4) Frontend Layer (Netlify)

Role:
- User interface and interaction.

Key variable:
- VITE_API_URL=https://api.funesterie.pro

Compatibility:
- frontend also supports VITE_API_BASE_URL for backward compatibility.

## End-to-End Flow

User
-> Frontend (Netlify)
-> Backend A11 (Railway)
-> Local LLM (GGUF via tunnel)
-> Text response
-> optional TTS synthesis
-> Audio playback

## Operating Rules

Do not:
- merge llm and tts into one service
- run GGUF inference directly on Railway

Do:
- route all inference through backend A11
- keep tunnel active for local LLM access
- expose one API base URL to frontend

## Design Philosophy

- LLM: reasoning brain
- TTS: voice layer
- Backend: orchestration and routing
- Frontend: interaction layer

## Final Target

- autonomous local-first system
- cloud fallback when needed
- strict modularity
- future extensibility (vision, tools, automation)
