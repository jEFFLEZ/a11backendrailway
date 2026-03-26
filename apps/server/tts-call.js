// Ajoute ce fichier dans ton backend Node.js (Express)
// Appel TTS universel compatible Railway

const TTS_URL = process.env.TTS_URL || "http://ttssiwis.railway.internal:8080";
const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));

/**
 * Appelle le service TTS (Python) et retourne un Buffer audio
 * @param {string} text Texte à synthétiser
 * @returns {Promise<Buffer>} Audio WAV
 */
async function callTTS(text) {
  const res = await fetch(`${TTS_URL}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (!res.ok) {
    throw new Error("TTS failed");
  }

  // On attend une réponse JSON avec audio_url
  const data = await res.json();
  if (!data.audio_url) {
    throw new Error("No audio_url in TTS response");
  }

  // On récupère le fichier audio
  const audioRes = await fetch(data.audio_url);
  if (!audioRes.ok) {
    throw new Error("Audio download failed");
  }
  return Buffer.from(await audioRes.arrayBuffer());
}

module.exports = { callTTS };
