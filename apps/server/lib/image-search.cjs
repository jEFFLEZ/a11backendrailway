// lib/image-search.cjs
// Recherche une image sur DuckDuckGo Images (pas d'API clé requise)
const https = require('https');

function duckduckgoImageSearch(query) {
  return new Promise((resolve, reject) => {
    const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    // 1. On doit d'abord récupérer le vqd token
    https.get(url, (res) => {
      let html = '';
      res.on('data', (chunk) => { html += chunk; });
      res.on('end', () => {
        const vqdMatch = html.match(/vqd='([\d-]+)'/);
        if (!vqdMatch) return reject(new Error('No vqd token found'));
        const vqd = vqdMatch[1];
        // 2. On appelle l'API images JSON
        const apiUrl = `https://duckduckgo.com/i.js?l=fr-fr&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`;
        https.get(apiUrl, (apiRes) => {
          let data = '';
          apiRes.on('data', (chunk) => { data += chunk; });
          apiRes.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.results && json.results.length > 0) {
                const img = json.results[0];
                resolve({
                  image_url: img.image,
                  source_url: img.url,
                  title: img.title || '',
                  width: img.width,
                  height: img.height
                });
              } else {
                reject(new Error('No image found'));
              }
            } catch (e) {
              reject(e);
            }
          });
        }).on('error', reject);
      });
    }).on('error', reject);
  });
}

module.exports = { duckduckgoImageSearch };