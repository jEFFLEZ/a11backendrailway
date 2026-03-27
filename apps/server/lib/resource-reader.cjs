const path = require('node:path');
const zlib = require('node:zlib');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx',
  '.mjs', '.cjs', '.py', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.html', '.css', '.scss', '.sass', '.less', '.xml', '.yml', '.yaml',
  '.toml', '.ini', '.env', '.sql', '.sh', '.ps1', '.bat', '.log', '.rtf',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cs',
  '.cpp', '.c', '.h', '.hpp', '.html', '.css', '.scss', '.sass', '.less',
  '.xml', '.yml', '.yaml', '.toml', '.ini', '.sql', '.sh', '.ps1', '.bat',
]);

const JSON_EXTENSIONS = new Set(['.json']);
const CSV_EXTENSIONS = new Set(['.csv']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const IMAGE_OCR_ENABLED = String(process.env.IMAGE_OCR_ENABLED || 'true').trim().toLowerCase() !== 'false';
const IMAGE_OCR_MAX_BYTES = Number(process.env.IMAGE_OCR_MAX_BYTES || 4 * 1024 * 1024);
const IMAGE_OCR_MAX_WIDTH = Number(process.env.IMAGE_OCR_MAX_WIDTH || 1600);
const IMAGE_OCR_TIMEOUT_MS = Number(process.env.IMAGE_OCR_TIMEOUT_MS || 20000);

let sharpLib = null;
let tesseractLib = null;

function getSharp() {
  if (sharpLib !== null) return sharpLib;
  try {
    sharpLib = require('sharp');
  } catch {
    sharpLib = null;
  }
  return sharpLib;
}

function getTesseract() {
  if (tesseractLib !== null) return tesseractLib;
  try {
    tesseractLib = require('tesseract.js');
  } catch {
    tesseractLib = null;
  }
  return tesseractLib;
}

function normalizeMime(contentType) {
  return String(contentType || '').trim().toLowerCase();
}

function getExtension(filename) {
  return path.extname(String(filename || '').trim().toLowerCase());
}

function inferResourceKind(contentType, filename) {
  const mime = normalizeMime(contentType);
  const extension = getExtension(filename);

  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime === 'application/json' || JSON_EXTENSIONS.has(extension)) return 'json';
  if (mime === 'text/csv' || CSV_EXTENSIONS.has(extension)) return 'csv';
  if (mime.startsWith('text/')) return CODE_EXTENSIONS.has(extension) ? 'code' : 'text';
  if (mime.includes('javascript') || mime.includes('typescript')) return 'code';
  if (mime.includes('yaml') || mime.includes('xml') || mime.includes('sql')) return 'code';
  if (TEXT_EXTENSIONS.has(extension)) return CODE_EXTENSIONS.has(extension) ? 'code' : 'text';
  return 'binary';
}

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let nullBytes = 0;
  for (const byte of sample) {
    if (byte === 0) nullBytes += 1;
  }
  return nullBytes > 0;
}

function truncateText(value, maxChars) {
  const text = String(value || '').trim();
  if (!text) return { text: '', truncated: false };
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`,
    truncated: true,
  };
}

function cleanTextPreview(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildPreviewFromText(text, options = {}) {
  const maxLines = Number(options.maxLines || 36);
  const maxChars = Number(options.maxChars || 1400);
  const lines = cleanTextPreview(text).split('\n').slice(0, maxLines);
  const clipped = truncateText(lines.join('\n'), maxChars);
  return {
    preview: clipped.text,
    truncated: clipped.truncated || lines.length >= maxLines,
    lineCount: cleanTextPreview(text) ? cleanTextPreview(text).split('\n').length : 0,
    charCount: cleanTextPreview(text).length,
  };
}

function promiseWithTimeout(promise, timeoutMs, code) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error(code || 'operation_timeout');
        error.code = code || 'operation_timeout';
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

function decodePdfLiteralString(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      result += char;
      continue;
    }

    index += 1;
    const next = value[index];
    if (next == null) break;

    if (next === 'n') result += '\n';
    else if (next === 'r') result += '\r';
    else if (next === 't') result += '\t';
    else if (next === 'b') result += '\b';
    else if (next === 'f') result += '\f';
    else if (next === '(' || next === ')' || next === '\\') result += next;
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let lookahead = 0; lookahead < 2; lookahead += 1) {
        const peek = value[index + 1];
        if (!peek || !/[0-7]/.test(peek)) break;
        index += 1;
        octal += peek;
      }
      result += String.fromCharCode(parseInt(octal, 8));
    } else if (next === '\n' || next === '\r') {
      if (next === '\r' && value[index + 1] === '\n') {
        index += 1;
      }
    } else {
      result += next;
    }
  }

  return result;
}

function decodePdfHexString(hexValue) {
  const normalized = String(hexValue || '').replace(/\s+/g, '');
  if (!normalized) return '';
  const padded = normalized.length % 2 === 0 ? normalized : `${normalized}0`;
  const buffer = Buffer.from(padded, 'hex');

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    let text = '';
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      text += String.fromCharCode(buffer.readUInt16BE(index));
    }
    return text;
  }

  return buffer.toString('utf8').replace(/\u0000/g, '') || buffer.toString('latin1');
}

function extractPdfTextOperators(source) {
  const chunks = [];

  const pushChunk = (value) => {
    const cleaned = cleanTextPreview(value);
    if (!cleaned) return;
    chunks.push(cleaned);
  };

  const parseScope = (scope) => {
    const literalMatches = scope.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj\b/g);
    for (const match of literalMatches) {
      pushChunk(decodePdfLiteralString(match[1]));
    }

    const hexMatches = scope.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj\b/g);
    for (const match of hexMatches) {
      pushChunk(decodePdfHexString(match[1]));
    }

    const arrayMatches = scope.matchAll(/\[(.*?)\]\s*TJ\b/gs);
    for (const match of arrayMatches) {
      const arrayScope = match[1];
      const literalParts = arrayScope.matchAll(/\(((?:\\.|[^\\()])*)\)/g);
      for (const part of literalParts) {
        pushChunk(decodePdfLiteralString(part[1]));
      }

      const hexParts = arrayScope.matchAll(/<([0-9A-Fa-f\s]+)>/g);
      for (const part of hexParts) {
        pushChunk(decodePdfHexString(part[1]));
      }
    }
  };

  const textBlocks = Array.from(source.matchAll(/BT[\s\S]*?ET/g)).map((match) => match[0]);
  if (textBlocks.length) {
    for (const block of textBlocks) parseScope(block);
  } else {
    parseScope(source);
  }

  return chunks;
}

function extractPdfTextPreview(buffer) {
  const sources = [];
  const raw = buffer.toString('latin1');
  sources.push(raw);

  const streamMatches = raw.matchAll(/<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gs);
  for (const match of streamMatches) {
    const dictionary = String(match[1] || '');
    const streamText = String(match[2] || '');
    if (dictionary.includes('/FlateDecode')) {
      try {
        const inflated = zlib.inflateSync(Buffer.from(streamText, 'latin1'));
        sources.push(inflated.toString('latin1'));
      } catch {
        // ignore broken or unsupported stream variants
      }
    } else {
      sources.push(streamText);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const source of sources) {
    const chunks = extractPdfTextOperators(source);
    for (const chunk of chunks) {
      const normalized = cleanTextPreview(chunk);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      deduped.push(normalized);
    }
  }

  const previewInfo = buildPreviewFromText(deduped.join('\n\n'), {
    maxLines: 40,
    maxChars: 1800,
  });

  return {
    preview: previewInfo.preview,
    truncated: previewInfo.truncated,
    blockCount: deduped.length,
    charCount: deduped.join('\n\n').length,
  };
}

async function analyzeImageBuffer(buffer, mime) {
  const sharp = getSharp();
  let metadata = null;
  let preparedBuffer = buffer;

  if (sharp) {
    try {
      const image = sharp(buffer, { failOn: 'none' });
      metadata = await image.metadata();
      preparedBuffer = await image
        .rotate()
        .resize({
          width: IMAGE_OCR_MAX_WIDTH,
          withoutEnlargement: true,
        })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
    } catch {
      metadata = null;
      preparedBuffer = buffer;
    }
  }

  const base = {
    readableInChatContext: false,
    parser: 'image_metadata',
    preview: '',
    width: Number(metadata?.width || 0) || null,
    height: Number(metadata?.height || 0) || null,
    density: Number(metadata?.density || 0) || null,
    format: String(metadata?.format || mime || 'image').trim() || 'image',
    note: 'image_recue_sans_texte_detecte',
  };

  if (!IMAGE_OCR_ENABLED) {
    return {
      ...base,
      parser: 'image_ocr_disabled',
      note: 'ocr_image_desactive',
    };
  }

  if (buffer.length > IMAGE_OCR_MAX_BYTES) {
    return {
      ...base,
      parser: 'image_ocr_skipped_size',
      note: 'ocr_image_ignoree_taille',
    };
  }

  const Tesseract = getTesseract();
  const recognize = Tesseract?.recognize || Tesseract?.default?.recognize;
  if (typeof recognize !== 'function') {
    return {
      ...base,
      parser: 'image_ocr_unavailable',
      note: 'ocr_image_indisponible',
    };
  }

  try {
    const result = await promiseWithTimeout(
      recognize(preparedBuffer, 'fra+eng', { logger: () => {} }),
      IMAGE_OCR_TIMEOUT_MS,
      'image_ocr_timeout'
    );
    const text = cleanTextPreview(result?.data?.text || result?.text || '');
    if (!text) {
      return {
        ...base,
        parser: 'image_ocr_empty',
        note: 'ocr_image_aucun_texte',
      };
    }

    const previewInfo = buildPreviewFromText(text, {
      maxLines: 24,
      maxChars: 1200,
    });

    return {
      ...base,
      readableInChatContext: true,
      parser: 'image_ocr',
      preview: previewInfo.preview,
      truncated: previewInfo.truncated,
      charCount: previewInfo.charCount,
      lineCount: previewInfo.lineCount,
      note: null,
    };
  } catch (error_) {
    return {
      ...base,
      parser: String(error_?.code || 'image_ocr_failed'),
      note: 'ocr_image_echec',
      error: String(error_?.message || error_),
    };
  }
}

function analyzeTextBuffer(buffer, fileKind) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return {
      readableInChatContext: false,
      parser: 'empty',
      preview: '',
      note: 'fichier_vide',
    };
  }

  if (isLikelyBinary(buffer)) {
    return {
      readableInChatContext: false,
      parser: 'binary_detected',
      preview: '',
      note: 'contenu_binaire_non_lisible',
    };
  }

  const rawText = buffer.toString('utf8');
  let parsedText = rawText;
  let parser = 'utf8_text';

  if (fileKind === 'json') {
    try {
      parsedText = JSON.stringify(JSON.parse(rawText), null, 2);
      parser = 'json';
    } catch {
      parser = 'json_text_fallback';
    }
  } else if (fileKind === 'csv') {
    parser = 'csv_text';
  } else if (fileKind === 'code') {
    parser = 'code_text';
  }

  const previewInfo = buildPreviewFromText(parsedText, {
    maxLines: fileKind === 'csv' ? 24 : 36,
    maxChars: fileKind === 'csv' ? 1200 : 1600,
  });

  return {
    readableInChatContext: !!previewInfo.preview,
    parser,
    preview: previewInfo.preview,
    truncated: previewInfo.truncated,
    lineCount: previewInfo.lineCount,
    charCount: previewInfo.charCount,
    note: previewInfo.preview ? null : 'texte_vide',
  };
}

async function analyzeUploadedResource({ filename, contentType, buffer }) {
  const extension = getExtension(filename);
  const fileKind = inferResourceKind(contentType, filename);
  const base = {
    fileKind,
    extension,
    mime: normalizeMime(contentType) || 'application/octet-stream',
    sizeBytes: Buffer.isBuffer(buffer) ? buffer.length : 0,
  };

  if (fileKind === 'text' || fileKind === 'code' || fileKind === 'json' || fileKind === 'csv') {
    return {
      ...base,
      ...analyzeTextBuffer(buffer, fileKind),
    };
  }

  if (fileKind === 'image') {
    return {
      ...base,
      ...(await analyzeImageBuffer(buffer, base.mime)),
    };
  }

  if (fileKind === 'pdf') {
    const pdfPreview = extractPdfTextPreview(buffer);
    if (pdfPreview.preview) {
      return {
        ...base,
        readableInChatContext: true,
        parser: 'pdf_text_heuristic',
        preview: pdfPreview.preview,
        truncated: pdfPreview.truncated,
        charCount: pdfPreview.charCount,
        blockCount: pdfPreview.blockCount,
        note: null,
      };
    }

    return {
      ...base,
      readableInChatContext: false,
      parser: 'pdf_text_unavailable',
      preview: '',
      note: 'pdf_recu_mais_texte_non_extractible',
    };
  }

  return {
    ...base,
    readableInChatContext: false,
    parser: 'unsupported',
    preview: '',
    note: 'type_non_lisible_automatiquement',
  };
}

function buildConversationResourceContext(resources, options = {}) {
  const maxResources = Math.max(1, Math.min(8, Number(options.maxResources || 4)));
  const selected = (Array.isArray(resources) ? resources : []).slice(0, maxResources);
  if (!selected.length) return '';

  const lines = ['Ressources recentes de la conversation (contexte uniquement):'];
  for (const resource of selected) {
    const metadata = resource?.metadata && typeof resource.metadata === 'object' ? resource.metadata : {};
    const analysis = metadata.analysis && typeof metadata.analysis === 'object' ? metadata.analysis : {};
    const kindLabel = String(resource.resourceKind || 'file');
    const mime = String(resource.contentType || analysis.mime || 'application/octet-stream');
    const identifier = Number(resource?.id || 0);
    lines.push(`- #${identifier > 0 ? identifier : '?'} ${String(resource.filename || 'fichier')} [${kindLabel}, ${mime}]`);

    if (resource?.url) {
      lines.push(`  URL: ${String(resource.url)}`);
    }

    if (analysis.readableInChatContext && analysis.preview) {
      const preview = truncateText(String(analysis.preview || ''), 500).text;
      lines.push(`  Extrait utile:\n${preview}`);
      continue;
    }

    if (analysis.note) {
      lines.push(`  Note: ${String(analysis.note)}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  analyzeUploadedResource,
  buildConversationResourceContext,
};
