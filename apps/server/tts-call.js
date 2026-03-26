// Ajoute ce fichier dans ton backend Node.js (Express)
// Appel TTS universel compatible Railway

const TTS_URL = process.env.TTS_URL || "http://ttssiwis.railway.internal:8080";
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

function toAbsoluteUrl(baseUrl, value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const publicBase = String(process.env.TTS_PUBLIC_BASE_URL || "").trim();
  if (/^https?:\/\//i.test(raw)) {
    if (!publicBase) return raw;
    try {
      const url = new URL(raw);
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname.endsWith(".railway.internal")) {
        return new URL(`${url.pathname}${url.search}`, `${publicBase.replace(/\/$/, '')}/`).toString();
      }
    } catch {
      return raw;
    }
    return raw;
  }
  const effectiveBase = publicBase || baseUrl;
  return new URL(raw.replace(/^\.\//, ''), `${String(effectiveBase).replace(/\/$/, '')}/`).toString();
}

/**
 * Appelle le service TTS (Python) et retourne une réponse JSON normalisée
 * @param {string | { text: string, voice?: string, model?: string }} payload Texte ou payload à synthétiser
 * @returns {Promise<object>} Réponse TTS
 */
async function callTTS(payload) {
  const baseUrl = String(TTS_URL).replace(/\/$/, "");
  const body = typeof payload === "string" ? { text: payload } : payload;
  const res = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TTS failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  if (!data.audio_url) {
    throw new Error("No audio_url in TTS response");
  }

  return {
    ...data,
    audio_url: toAbsoluteUrl(baseUrl, data.audio_url),
    gif_url: toAbsoluteUrl(baseUrl, data.gif_url),
  };
}

module.exports = { callTTS };
