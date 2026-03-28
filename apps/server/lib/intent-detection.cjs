// Détection d'intention pour génération d'image (FR/EN)
function detectImageIntent(message) {
  if (!message || typeof message !== 'string') return false;
  const patterns = [
    /\b(génère|générer|génération|crée|créer|dessine|dessiner|fais|faire|fabrique|produis|produire)\b.*\b(image|illustration|dessin|photo|visuel|dessiner)\b/i,
    /\b(image|illustration|drawing|picture|photo|visual|art|generate|create|draw|make|produce)\b.*\b(cat|dog|scene|city|robot|animal|person|character|landscape|object|thing|photo|picture|illustration|drawing|art)\b/i,
    /\b(generate|create|draw|make|produce)\b.*\b(image|illustration|drawing|picture|photo|visual|art)\b/i
  ];
  return patterns.some((re) => re.test(message));
}

// Détection "montre-moi une image de X" (image réelle web)
function detectWebImageIntent(message) {
  if (!message || typeof message !== 'string') return false;
  // Ex: "montre-moi une image de Goku"
  return /montre(-| )?moi (une|un)? ?image de ([^\?\.\!]+)/i.test(message);
}

function extractWebImageSubject(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.match(/montre(-| )?moi (une|un)? ?image de ([^\?\.\!]+)/i);
  if (m && m[3]) return m[3].trim();
  return null;
}

module.exports = { detectImageIntent, detectWebImageIntent, extractWebImageSubject };
