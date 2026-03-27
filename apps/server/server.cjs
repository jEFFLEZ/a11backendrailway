// --- Express setup: always at the very top ---
const express = require('express');
const app = express();

// --- Endpoint de healthcheck Railway ---
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
// ...existing code...
// --- .env first ---
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const fs = require('node:fs');
const dotenv = require('dotenv');
const { buildRuntimeConfig, getPublicRuntimeStatus } = require('./lib/runtime-config.cjs');

// A11Host (VSIX + headless)
const {
  registerA11HostRoutes,
  setHeadlessConfig,
  getA11HostStatus,
  getA11HostCapabilities
} = require('./a11host.cjs'); // adapte le chemin si besoin

// Prevent DeprecationWarning for util._extend by replacing it early with Object.assign
try {
  const coreUtil = require('node:util');
  if (coreUtil?._extend !== undefined) coreUtil._extend = Object.assign; 
} catch (error_) {
  console.warn('[A11] util bootstrap failed:', error_.message);
}

// Prefer server-local env (.env.local) for dev, fallback to repo root .env
const localEnvPath = path.resolve(__dirname, '.env.local');
const repoEnvPath = path.resolve(__dirname, '../../.env');
let envSource = null;
if (fs.existsSync(localEnvPath)) {
  console.log('[A11] Chargement des variables d\'environnement depuis', localEnvPath);
  dotenv.config({ path: localEnvPath });
  envSource = localEnvPath;
} else if (fs.existsSync(repoEnvPath)) {
  console.log('[A11] Chargement des variables d\'environnement depuis', repoEnvPath);
  dotenv.config({ path: repoEnvPath });
  envSource = repoEnvPath;
} else {
  console.log('[A11] Aucun fichier .env trouvé (cherche .env.local puis ../../.env)');
  envSource = 'ENVIRONMENT ONLY';
}

function adoptEnvAlias(target, aliases) {
  const current = String(process.env[target] || '').trim();
  if (current) {
    process.env[target] = current;
    return current;
  }

  for (const alias of aliases) {
    const candidate = String(process.env[alias] || '').trim();
    if (!candidate) continue;
    process.env[target] = candidate;
    return candidate;
  }

  return '';
}

adoptEnvAlias('PUBLIC_API_URL', ['API_URL', 'A11_SERVER_URL']);
adoptEnvAlias('API_URL', ['PUBLIC_API_URL', 'A11_SERVER_URL']);
adoptEnvAlias('LLM_ROUTER_URL', ['VITE_LLM_ROUTER_URL']);
adoptEnvAlias('A11_OPENAI_BASE_URL', ['OPENAI_BASE_URL']);
adoptEnvAlias('A11_OPENAI_MODEL', ['OPENAI_MODEL']);
adoptEnvAlias('R2_BUCKET', ['R2_BUCKET_NAME']);
adoptEnvAlias('R2_ACCESS_KEY', ['R2_ACCESS_KEY_ID']);
adoptEnvAlias('R2_SECRET_KEY', ['R2_SECRET_ACCESS_KEY']);
adoptEnvAlias('TTS_PUBLIC_BASE_URL', ['TTS_BASE_URL']);
adoptEnvAlias('TTS_MODEL_PATH', ['MODEL_PATH']);
adoptEnvAlias('MODEL_PATH', ['TTS_MODEL_PATH']);

// DEBUG: log Nez env vars
console.log('[NEZ ENV] NEZ_TOKENS=', process.env.NEZ_TOKENS);
console.log('[NEZ ENV] NEZ_ADMIN_TOKEN=', process.env.NEZ_ADMIN_TOKEN);
console.log('[NEZ ENV] NEZ_ALLOWED_TOKEN=', process.env.NEZ_ALLOWED_TOKEN);

// Ensure runtime configuration defaults are set to avoid ReferenceErrors
const CTX_SIZE = Number(process.env.CTX_SIZE) || 8192;
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 4096;
const PARALLEL = Number(process.env.PARALLEL) || 8;

const runtimeConfig = buildRuntimeConfig(process.env);
const CHAT_TIMEZONE = String(process.env.A11_CHAT_TIMEZONE || process.env.TZ || 'Europe/Paris').trim() || 'Europe/Paris';
const CHAT_TIME_LOCALE = String(process.env.A11_CHAT_LOCALE || 'fr-FR').trim() || 'fr-FR';

// Set remote qflush URL for production (allow env override)
process.env.QFLUSH_URL = runtimeConfig.qflush.remoteUrl;
process.env.QFLUSH_REMOTE_URL = runtimeConfig.qflush.remoteUrl;

const qflushIntegration = require('./src/qflush-integration.cjs');
const { setupA11Supervisor, runQflushFlow } = qflushIntegration;

// -------------------

// --- Compilation automatique de openai.ts ---
const { execSync } = require('node:child_process');
const tsPath = path.resolve(__dirname, 'providers', 'openai.ts');
const jsPath = path.resolve(__dirname, 'providers', 'openai.js');
try {
  const tsMtime = fs.existsSync(tsPath) ? fs.statSync(tsPath).mtimeMs : 0;
  const jsMtime = fs.existsSync(jsPath) ? fs.statSync(jsPath).mtimeMs : 0;
  if (tsMtime > jsMtime || !fs.existsSync(jsPath)) {
    console.log('[A11] Compilation automatique de openai.ts...');
    execSync("npx tsc \"" + tsPath + "\" --outDir \"" + path.dirname(tsPath) + "\"");
    console.log('[A11] Compilation terminée.');
  }
} catch (e) {
  console.warn('[A11] Erreur compilation openai.ts:', e.message);
}
// -------------------

// Import all required modules at the top
const { spawn } = require('node:child_process');
const { Router } = require('express');
const { registerOpenAIRoutes } = require('./src/routes/llm-openai');
const cors = require('cors');
const compression = require('compression');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const crypto = require('node:crypto');
// OpenAI SDK (CommonJS)
let OpenAI;
try {
  OpenAI = require('openai');
} catch (error_) {
  console.warn('[A11] OpenAI SDK unavailable:', error_.message);
  OpenAI = null;
}

const openaiClient = OpenAI ? new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || (process.env.UPSTREAM_ORIGIN || 'https://api.funesterie.me') + '/v1',
  apiKey: process.env.OPENAI_API_KEY || 'dummy',
  defaultHeaders: {
    'X-NEZ-TOKEN': process.env.NEZ_ALLOWED_TOKEN || process.env.NEZ_TOKENS || 'nez:a11-client-funesterie-pro'
  }
}) : null;
const multer = require('multer');
const open = require('open');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { nezAuth, getNezAccessLog, TOKENS, MODE, registerIssuedToken } = require('./src/middleware/nezAuth');
const { createFileStorage } = require('./lib/file-storage.cjs');
const { ingestUploadedFile } = require('./lib/file-ingestion.cjs');
const { createArtifact, normalizeArtifactKind, buildArtifactOrigin } = require('./lib/artifact-manager.cjs');
const { createEmailService } = require('./lib/email-service.cjs');
const { analyzeUploadedResource, buildConversationResourceContext } = require('./lib/resource-reader.cjs');

const BASE = path.resolve(__dirname);
const LLAMA_DIR = path.join(BASE, 'llama.cpp');
const BIN_DIR_REL = path.join('build', 'bin', 'Release');
const BIN_DIR_FALLBACK = path.join('build', 'bin');

// qflush supervisor integration: detect if available (try module first, then local exe)
let QFLUSH_AVAILABLE = false;
let QFLUSH_MODULE = null;
let QFLUSH_PATH = null;
try {
  // Avoid requiring 'qflush' at top-level because the package may auto-run its pipeline on require()
  // Instead detect presence of the package and defer requiring it to the qflush-integration helper
  const qflushModuleDir = path.join(BASE, 'node_modules', '@funeste38', 'qflush');
  if (fs.existsSync(qflushModuleDir)) {
    QFLUSH_AVAILABLE = true;
    console.log('[QFLUSH] qflush module found in node_modules; will initialize via integration helper');
  } else {
    // fallback: check for a local qflush executable in project folders
    const qflushCandidates = [
      path.join(BASE, '.qflush', 'qflush.exe'),
      path.join(BASE, 'qflush', 'qflush.exe'),
      path.join(BASE, 'bin', 'qflush.exe')
    ];
    for (const candidate of qflushCandidates) {
      try {
        if (fs.existsSync(candidate)) {
          QFLUSH_PATH = candidate;
          QFLUSH_AVAILABLE = true;
          console.log('[QFLUSH] Found local qflush executable at', candidate);
          break;
        }
      } catch (error_) {
        console.debug('[QFLUSH] candidate check failed:', error_.message);
      }
    }
    if (!QFLUSH_AVAILABLE) {
      console.log('[QFLUSH] qflush integration not available. Skipping.');
    }
  }
} catch (e) {
  console.log('[QFLUSH] qflush detection failed:', e?.message);
}

// export for other modules to check
globalThis.__QFLUSH_AVAILABLE = QFLUSH_AVAILABLE;
globalThis.__QFLUSH_MODULE = QFLUSH_MODULE;
globalThis.__QFLUSH_PATH = QFLUSH_PATH;

// Initialize qflush supervisor if available
if (QFLUSH_AVAILABLE) {
  try {
    setupA11Supervisor().then((supervisor) => {
      if (supervisor) {
        console.log('[Supervisor] A11 supervisor initialized');
        globalThis.__A11_SUPERVISOR = supervisor;
        globalThis.__A11_QFLUSH_SUPERVISOR = supervisor;
        // Optionally start managed processes
        // Note: On Railway (cloud), local processes won't start
      }
    }).catch((e) => {
      console.warn('[Supervisor] Setup failed:', e.message);
    });
  } catch (e) {
    console.warn('[Supervisor] Load failed:', e.message);
  }
}

// --- Mémoire persistante A-11 (conversations) ---
const fsMem = require('node:fs');
const pathMem = require('node:path');

const A11_WORKSPACE_ROOT =
  process.env.A11_WORKSPACE_ROOT ||
  pathMem.resolve(__dirname, '..', '..'); // ex: D:\A11

const A11_MEMORY_ROOT = pathMem.join(A11_WORKSPACE_ROOT, 'a11_memory');
const A11_CONV_DIR = pathMem.join(A11_MEMORY_ROOT, 'conversations');

function ensureConvDir() {
  try {
    if (!fsMem.existsSync(A11_CONV_DIR)) {
      fsMem.mkdirSync(A11_CONV_DIR, { recursive: true });
    }
  } catch (e) {
    console.warn('[A11][memory] mkdir failed:', e?.message);
  }
}

function appendConversationLog(entry) {
  try {
    ensureConvDir();
    const ts = new Date();
    const day = ts.toISOString().slice(0, 10).replaceAll('-', '');
    const file = pathMem.join(A11_CONV_DIR, `${day}.jsonl`);
    const payload = { ts: ts.toISOString(), ...entry };
    fsMem.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
  } catch (e) {
    console.warn('[A11][memory] append failed:', e?.message);
  }
}

function readConversationLogEntries({ userId, conversationId, limit = 20 } = {}) {
  try {
    ensureConvDir();
    if (!fsMem.existsSync(A11_CONV_DIR)) return [];

    const normalizedUserId = String(userId || '').trim();
    const normalizedConversationId = normalizeConversationId(conversationId);
    const normalizedLimit = Math.max(1, Math.min(100, Number(limit || 20)));
    const files = fsMem
      .readdirSync(A11_CONV_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.jsonl'))
      .map((dirent) => dirent.name)
      .sort((a, b) => b.localeCompare(a));
    const entries = [];

    for (const filename of files) {
      const fullPath = pathMem.join(A11_CONV_DIR, filename);
      let raw;
      try {
        raw = fsMem.readFileSync(fullPath, 'utf8');
      } catch (error_) {
        console.warn('[A11][memory] read activity file failed:', fullPath, error_?.message);
        continue;
      }

      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean).reverse();
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (error_) {
          console.warn('[A11][memory] activity JSON parse error in', fullPath, error_?.message);
          continue;
        }

        const rawConversationId = String(entry?.conversationId || '').trim();
        const entryUserId = String(entry?.userId || '').trim();
        if (!rawConversationId) continue;
        if (normalizeConversationId(rawConversationId) !== normalizedConversationId) continue;
        if (normalizedUserId && (!entryUserId || entryUserId !== normalizedUserId)) continue;

        entries.push(entry);
        if (entries.length >= normalizedLimit) {
          return entries;
        }
      }
    }

    return entries;
  } catch (error_) {
    console.warn('[A11][memory] read activity failed:', error_?.message);
    return [];
  }
}

function purgeConversationLogEntries({ userId, conversationId } = {}) {
  try {
    ensureConvDir();
    if (!fsMem.existsSync(A11_CONV_DIR)) {
      return { removedEntries: 0, touchedFiles: 0 };
    }

    const normalizedUserId = String(userId || '').trim();
    const hasConversationFilter = String(conversationId || '').trim().length > 0;
    const normalizedConversationId = hasConversationFilter ? normalizeConversationId(conversationId) : '';
    if (!normalizedUserId) {
      return { removedEntries: 0, touchedFiles: 0 };
    }

    const files = fsMem
      .readdirSync(A11_CONV_DIR, { withFileTypes: true })
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.jsonl'))
      .map((dirent) => dirent.name);

    let removedEntries = 0;
    let touchedFiles = 0;

    for (const filename of files) {
      const fullPath = pathMem.join(A11_CONV_DIR, filename);
      let raw;
      try {
        raw = fsMem.readFileSync(fullPath, 'utf8');
      } catch (error_) {
        console.warn('[A11][memory] purge read failed:', fullPath, error_?.message);
        continue;
      }

      const nextLines = [];
      let fileTouched = false;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let shouldRemove = false;
        try {
          const entry = JSON.parse(trimmed);
          const entryUserId = String(entry?.userId || '').trim();
          const entryConversationId = normalizeConversationId(entry?.conversationId);
          if (entryUserId === normalizedUserId) {
            shouldRemove = !hasConversationFilter || entryConversationId === normalizedConversationId;
          }
        } catch {
          nextLines.push(trimmed);
          continue;
        }

        if (shouldRemove) {
          removedEntries += 1;
          fileTouched = true;
          continue;
        }

        nextLines.push(trimmed);
      }

      if (!fileTouched) continue;
      touchedFiles += 1;

      try {
        if (nextLines.length) {
          fsMem.writeFileSync(fullPath, `${nextLines.join('\n')}\n`, 'utf8');
        } else {
          fsMem.unlinkSync(fullPath);
        }
      } catch (error_) {
        console.warn('[A11][memory] purge write failed:', fullPath, error_?.message);
      }
    }

    return { removedEntries, touchedFiles };
  } catch (error_) {
    console.warn('[A11][memory] purge activity failed:', error_?.message);
    return { removedEntries: 0, touchedFiles: 0 };
  }
}

function truncateConversationActivityText(value, maxLength = 180) {
  const normalized = normalizeMemoryText(value);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildConversationActivityEntry(entry, index = 0) {
  const type = String(entry?.type || 'event').trim() || 'event';
  const ts = String(entry?.ts || new Date().toISOString()).trim() || new Date().toISOString();
  const id = `${type}-${ts}-${index}`;

  if (type === 'file_uploaded') {
    const file = entry?.file || {};
    const analysis = entry?.analysis || {};
    return {
      id,
      type,
      tone: 'file',
      ts,
      title: 'Fichier ajoute',
      summary: truncateConversationActivityText(file.filename || 'Fichier rattache a la conversation', 140),
      detail: truncateConversationActivityText(
        analysis.preview
          || analysis.note
          || `${file.contentType || 'application/octet-stream'}${file.sizeBytes ? ` • ${file.sizeBytes} bytes` : ''}`,
        180
      ),
    };
  }

  if (type === 'artifact_created') {
    const artifact = entry?.artifact || {};
    const mail = entry?.mail || null;
    return {
      id,
      type,
      tone: 'artifact',
      ts,
      title: 'Artefact cree',
      summary: truncateConversationActivityText(
        artifact.kind
          ? `${artifact.filename || 'Artefact'} (${artifact.kind})`
          : (artifact.filename || 'Artefact genere'),
        140
      ),
      detail: truncateConversationActivityText(
        artifact.description
          || (mail?.to ? `Pret et envoye vers ${mail.to}` : 'Stocke pour reutilisation dans la conversation.'),
        180
      ),
    };
  }

  if (type === 'resource_emailed') {
    const resource = entry?.resource || {};
    const mail = entry?.mail || {};
    return {
      id,
      type,
      tone: 'mail',
      ts,
      title: 'Ressource envoyee',
      summary: truncateConversationActivityText(
        `${resource.filename || 'Ressource'}${mail.to ? ` -> ${mail.to}` : ''}`,
        140
      ),
      detail: truncateConversationActivityText(
        mail.attachmentIncluded
          ? 'Envoi avec piece jointe.'
          : (mail.attachmentFallbackReason
            ? `Lien envoye (${mail.attachmentFallbackReason}).`
            : 'Envoi par lien public.'),
        180
      ),
    };
  }

  if (type === 'resource_downloaded') {
    const resource = entry?.resource || {};
    return {
      id,
      type,
      tone: 'file',
      ts,
      title: 'Ressource telechargee',
      summary: truncateConversationActivityText(resource.filename || 'Document telecharge', 140),
      detail: truncateConversationActivityText(
        `${resource.contentType || 'application/octet-stream'}${resource.sizeBytes ? ` • ${resource.sizeBytes} bytes` : ''}`,
        180
      ),
    };
  }

  if (type === 'chat_turn') {
    const requestMessages = Array.isArray(entry?.request?.messages) ? entry.request.messages : [];
    const latestUserMessage = requestMessages
      .slice()
      .reverse()
      .find((message) => String(message?.role || '').trim() === 'user');
    const assistantContent = extractAssistantText(entry?.response || {});
    return {
      id,
      type,
      tone: 'chat',
      ts,
      title: 'Echange avec A11',
      summary: truncateConversationActivityText(
        latestUserMessage?.content || entry?.request?.prompt || 'Question utilisateur',
        140
      ),
      detail: truncateConversationActivityText(
        assistantContent || entry?.request?.model || 'Reponse assistant enregistree.',
        180
      ),
    };
  }

  if (type === 'agent_actions') {
    const actionCount = Array.isArray(entry?.cerbere?.results)
      ? entry.cerbere.results.length
      : (Array.isArray(entry?.cerbere?.actions) ? entry.cerbere.actions.length : 0);
    return {
      id,
      type,
      tone: 'agent',
      ts,
      title: 'Action agent',
      summary: truncateConversationActivityText(
        entry?.envelope?.title
          || entry?.envelope?.goal
          || entry?.explanation
          || 'Execution outillee via agent',
        140
      ),
      detail: truncateConversationActivityText(
        actionCount > 0
          ? `${actionCount} action(s) executee(s).`
          : (entry?.imagePath ? `Image produite: ${entry.imagePath}` : 'Execution agent tracee.'),
        180
      ),
    };
  }

  return {
    id,
    type,
    tone: 'neutral',
    ts,
    title: 'Activite',
    summary: truncateConversationActivityText(entry?.summary || entry?.message || type, 140),
    detail: '',
  };
}
// --- Fin bloc mémoire persistante ---

// --- Mémoire persistante A-11 : MEMOS JSON ---
const A11_MEMO_DIR    = pathMem.join(A11_MEMORY_ROOT, 'memos');
const A11_MEMO_INDEX  = pathMem.join(A11_MEMO_DIR, 'memo_index.jsonl');

function ensureMemoDir() {
  try {
    fsMem.mkdirSync(A11_MEMO_DIR, { recursive: true });
  } catch (e) {
    console.warn('[A11][memo] mkdir failed:', e?.message);
  }
}

function saveMemo(type, data) {
  try {
    ensureMemoDir();
    const ts = new Date().toISOString();
    const id = `memo_${type}_${Date.now()}`;

    const memoFile = pathMem.join(A11_MEMO_DIR, `${id}.json`);
    const entry = { id, ts, type, data };

    // Fichier mémo complet
    fsMem.writeFileSync(memoFile, JSON.stringify(entry, null, 2), 'utf8');

    // Index JSONL (append)
    fsMem.appendFileSync(A11_MEMO_INDEX, JSON.stringify(entry) + '\n', 'utf8');

    return entry;
  } catch (e) {
    console.warn('[A11][memo] save failed:', e?.message);
    return null;
  }
}

function loadAllMemos() {
  try {
    ensureMemoDir();
    if (!fsMem.existsSync(A11_MEMO_INDEX)) return [];

    const raw = fsMem.readFileSync(A11_MEMO_INDEX, 'utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    const entries = [];
    for (const l of lines) {
      try { entries.push(JSON.parse(l)); } catch {}
    }

    entries.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    return entries;
  } catch (e) {
    console.warn('[A11][memo] load failed:', e?.message);
    return [];
  }
}

function summarizeMemoEntries(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const byType = {};
  let latestTs = '';
  let oldestTs = '';

  for (const entry of list) {
    const type = String(entry?.type || 'memo').trim() || 'memo';
    byType[type] = Number(byType[type] || 0) + 1;
    const ts = String(entry?.ts || '').trim();
    if (ts) {
      if (!latestTs || ts > latestTs) latestTs = ts;
      if (!oldestTs || ts < oldestTs) oldestTs = ts;
    }
  }

  return {
    total: list.length,
    byType,
    latestTs: latestTs || null,
    oldestTs: oldestTs || null,
  };
}

function purgeTechnicalMemos() {
  ensureMemoDir();
  const entries = loadAllMemos();
  const summary = summarizeMemoEntries(entries);
  let removedFiles = 0;
  let removedIndex = false;

  try {
    if (fsMem.existsSync(A11_MEMO_DIR)) {
      const files = fsMem.readdirSync(A11_MEMO_DIR, { withFileTypes: true });
      for (const file of files) {
        if (!file?.isFile?.()) continue;
        if (!/\.json(?:l)?$/i.test(String(file.name || ''))) continue;
        const fullPath = pathMem.join(A11_MEMO_DIR, file.name);
        fsMem.unlinkSync(fullPath);
        removedFiles += 1;
        if (fullPath === A11_MEMO_INDEX || file.name === 'memo_index.jsonl') {
          removedIndex = true;
        }
      }
    }
  } catch (e) {
    console.warn('[A11][memo] purge failed:', e?.message);
    throw e;
  }

  ensureMemoDir();
  return {
    ok: true,
    removedEntries: Number(summary.total || 0),
    removedFiles,
    removedIndex,
    byType: summary.byType,
    latestTs: summary.latestTs,
    oldestTs: summary.oldestTs,
  };
}
// --- FIN MEMOS JSON ---

// === Upload (OCR) - use memory storage to avoid disk writes ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});
const { WebSocketServer } = require('ws');

// ...existing code...

// --- Endpoint API TTS universel --- (corrigé)
const { callTTS } = require('./tts-call.js');
app.post('/api/tts', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const voice = String(req.body?.voice || req.body?.model || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Texte manquant' });
    }
    const result = await callTTS({ text, voice, model: voice || undefined });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'TTS error', details: String(e) });
  }
});
const router = Router();

// Racine de travail (doit pointer sur D:\A12 chez toi en .env)
const WORKSPACE_ROOT = process.env.A11_WORKSPACE_ROOT || path.resolve(__dirname, '..', '..');

// Exposer le workspace en lecture seule sous /files
app.use('/files', express.static(WORKSPACE_ROOT, {
  dotfiles: 'ignore',
  maxAge: '1d'
}));
console.log('[A11] Static /files ->', WORKSPACE_ROOT);

// Config headless A11Host (active même sans Visual Studio/VSIX)
setHeadlessConfig({
  // Racine du workspace : adapte si besoin (ex: D:\A11, D:\A12, etc.)
  workspaceRoot: process.env.A11_WORKSPACE_ROOT || path.resolve(__dirname, '..', '..'),
  // Commande de build par défaut en mode headless
  // (tu peux mettre "dotnet build", "npm run build", etc.)
  buildCommand: process.env.A11_BUILD_COMMAND || null,
  // Répertoire courant pour ExecuteShell (sinon workspaceRoot)
  shellCwd: process.env.A11_SHELL_CWD || null
});



// Last generated GIF path (absolute on disk)
let lastGifPath = null;

function _find_idle_asset() {
  // Keep backend avatar assets self-contained now that the frontend lives in a separate repo.
  const cand = [
    path.join(__dirname, 'public', 'assets', 'a11_static.png'),
    path.join(__dirname, 'public', 'assets', 'A11_idle.png'),
    path.join(__dirname, 'public', 'assets', 'A11_talking_smooth_8s.gif'),
    path.resolve(__dirname, '..', 'tts', 'A11_talking_smooth_8s.gif')
  ];
  for (const p of cand) {
    try { if (fs.existsSync(p)) return p; } catch {};
  }
  return null;
}

function getAvatarRedirectUrl(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  const basename = path.basename(raw);
  const publicTtsBaseUrl = String(runtimeConfig?.tts?.publicBaseUrl || '').trim();
  if (!publicTtsBaseUrl || !basename) {
    return null;
  }

  return `${publicTtsBaseUrl.replace(/\/$/, '')}/out/${encodeURIComponent(basename)}`;
}

// Avatar update API: called by the TTS service to notify the server of the latest generated GIF.
// In Railway, the backend cannot read TTS container paths directly, so keep the value as an opaque
// reference and prefer redirecting the browser to the public TTS /out/<file> URL.
app.post('/api/avatar/update', express.json(), (req, res) => {
  try {
    const gifPath = String(req.body?.gif_path || req.body?.gifPath || req.body?.gif_url || req.body?.gifUrl || '').trim();
    if (!gifPath) {
      return res.status(400).json({ error: 'gif_path missing' });
    }

    lastGifPath = gifPath;
    console.log('[A11][AVATAR] lastGifPath updated:', lastGifPath);
    return res.json({
      ok: true,
      gifPath: lastGifPath,
      redirectUrl: getAvatarRedirectUrl(lastGifPath),
    });
  } catch (e) {
    console.error('[A11][AVATAR] update error:', e && e.message);
    return res.status(500).json({ error: String(e && e.message) });
  }
});

// Serve the current avatar GIF. Prefer redirecting to the public TTS asset when available.
app.get('/avatar.gif', (req, res) => {
  try {
    const redirectUrl = getAvatarRedirectUrl(lastGifPath);
    if (redirectUrl) {
      console.log('[A11][AVATAR] redirecting avatar.gif to TTS server ->', redirectUrl);
      return res.redirect(307, redirectUrl);
    }

    if (!lastGifPath || !fs.existsSync(lastGifPath)) {
      const idle = _find_idle_asset();
      if (idle) {
        console.warn('[A11][AVATAR] lastGifPath empty/unavailable, serving idle asset:', idle);
        return res.sendFile(idle);
      }
      return res.status(404).send('no avatar available');
    }

    const st = fs.statSync(lastGifPath);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.setHeader('ETag', `W/"${st.size}-${st.mtimeMs}"`);

    const stream = fs.createReadStream(lastGifPath);
    stream.on('error', (err) => {
      console.error('[A11][AVATAR] error reading GIF:', err && err.message);
      const idle = _find_idle_asset();
      if (idle) return res.sendFile(idle);
      return res.status(500).send('avatar read error');
    });
    stream.pipe(res);
  } catch (e) {
    console.error('[A11][AVATAR] avatar.gif handler error:', e && e.message);
    const idle = _find_idle_asset();
    if (idle) return res.sendFile(idle);
    return res.status(500).send('avatar handler error');
  }
});

// CORS configuration: allow local dev origins and production origin
const defaultCorsOrigins = [
  'https://a11backendrailway.up.railway.app',
  'https://a11backendrailway.railway.app',
  'https://funesterie.pro',
  'https://a11.funesterie.pro'
];
const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/$/, '');
const envCorsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);
const CORS_ORIGINS = (envCorsOrigins.length ? envCorsOrigins : defaultCorsOrigins)
  .map(normalizeOrigin)
  .filter(Boolean);
const ALLOW_NETLIFY_PREVIEWS = String(process.env.CORS_ALLOW_NETLIFY_APP || '').trim().toLowerCase() === 'true';

const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (e.g., curl, mobile clients)
    if (!origin) return callback(null, true);
    const incomingOrigin = normalizeOrigin(origin);
    
    // Check exact matches
    if (CORS_ORIGINS.includes(incomingOrigin)) return callback(null, true);
    
    // Allow Netlify preview deployments: https://xxxxx--a11funesterie.netlify.app
    const netlifyPreviewPattern = /https:\/\/[a-z0-9-]*--a11funesterie\.netlify\.app$/i;
    if (ALLOW_NETLIFY_PREVIEWS && netlifyPreviewPattern.test(incomingOrigin)) {
      console.log('[A11][CORS] ✅ allowed Netlify preview:', incomingOrigin);
      return callback(null, true);
    }
    
    console.warn('[A11][CORS] origin denied:', incomingOrigin, 'allowed:', CORS_ORIGINS.join(','));
    return callback(new Error('CORS origin denied'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-NEZ-TOKEN', 'X-NEZ-ADMIN']
};

// Use CORS middleware globally
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ============================================================
// PostgreSQL pool (Railway Postgres)
// ============================================================
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const CHAT_MEMORY_LIMIT = Number(process.env.CHAT_MEMORY_LIMIT || 15);
const LOGICAL_MEMORY_UPDATE_EVERY = Number(process.env.LOGICAL_MEMORY_UPDATE_EVERY || 3);
const FACT_MEMORY_LIMIT = Number(process.env.FACT_MEMORY_LIMIT || 20);
const TASK_MEMORY_LIMIT = Number(process.env.TASK_MEMORY_LIMIT || 15);
const FILE_MEMORY_LIMIT = Number(process.env.FILE_MEMORY_LIMIT || 10);
const FACT_MIN_RELEVANCE = Number(process.env.FACT_MIN_RELEVANCE || 0.2);
const FACT_RETENTION_DAYS = Number(process.env.FACT_RETENTION_DAYS || 45);
const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS || 60);
const FILE_RETENTION_DAYS = Number(process.env.FILE_RETENTION_DAYS || 120);
const MEMORY_PURGE_EVERY_USER_MESSAGES = Number(process.env.MEMORY_PURGE_EVERY_USER_MESSAGES || 50);
const DEFAULT_QFLUSH_MEMORY_SUMMARY_FLOW = 'a11.memory.summary.v1';
const R2_ENDPOINT = String(process.env.R2_ENDPOINT || '').trim();
const R2_ACCESS_KEY = String(process.env.R2_ACCESS_KEY || '').trim();
const R2_SECRET_KEY = String(process.env.R2_SECRET_KEY || '').trim();
const R2_BUCKET = String(process.env.R2_BUCKET || '').trim();
const R2_PUBLIC_BASE_URL = String(process.env.R2_PUBLIC_BASE_URL || '').trim();
const FILE_UPLOAD_MAX_BYTES = Number(process.env.FILE_UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
const TEMP_SHARED_FILE_TTL_MS = Math.max(60 * 1000, Number(process.env.A11_SHARED_FILE_TTL_MS || 60 * 60 * 1000));
const TEMP_SHARED_FILE_CLEANUP_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.A11_SHARED_FILE_CLEANUP_INTERVAL_MS || 60 * 1000));
const DEFAULT_ADMIN_USERNAME = String(process.env.DEFAULT_ADMIN_USERNAME || 'Djeff').trim();
const DEFAULT_ADMIN_PASSWORD = String(process.env.DEFAULT_ADMIN_PASSWORD || '1991');
const DEFAULT_ADMIN_EMAIL = String(process.env.DEFAULT_ADMIN_EMAIL || 'djeff@a11.local').trim().toLowerCase();

if (db) {
  db.connect()
    .then(async (client) => {
      client.release();
      console.log('[DB] ✅ PostgreSQL connecté');
      try {
        await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT');
        await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP');
        await db.query(`
          CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            conversation_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
          )
        `);
        await db.query('CREATE INDEX IF NOT EXISTS idx_messages_user_created_at ON messages (user_id, created_at DESC)');
        await db.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id TEXT');
        await db.query('CREATE INDEX IF NOT EXISTS idx_messages_user_conversation_created_at ON messages (user_id, conversation_id, created_at DESC)');
        await db.query(`
          CREATE TABLE IF NOT EXISTS user_memory (
            user_id TEXT PRIMARY KEY,
            summary TEXT,
            updated_at TIMESTAMP DEFAULT NOW()
          )
        `);
        await db.query(`
          CREATE TABLE IF NOT EXISTS files (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            url TEXT NOT NULL,
            content_type TEXT,
            size_bytes INTEGER,
            created_at TIMESTAMP DEFAULT NOW()
          )
        `);
        await db.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS content_type TEXT');
        await db.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS size_bytes INTEGER');
        await db.query('ALTER TABLE files ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP');
        await db.query('CREATE INDEX IF NOT EXISTS idx_files_user_created_at ON files (user_id, created_at DESC)');
        await db.query('CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files (expires_at)');
        await db.query(`
          CREATE TABLE IF NOT EXISTS user_facts (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            fact_key TEXT NOT NULL,
            fact_value TEXT NOT NULL,
            confidence REAL,
            relevance_score REAL DEFAULT 0.5,
            source TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            last_seen_at TIMESTAMP DEFAULT NOW(),
            last_used_at TIMESTAMP,
            UNIQUE (user_id, fact_key)
          )
        `);
        await db.query('ALTER TABLE user_facts ADD COLUMN IF NOT EXISTS relevance_score REAL DEFAULT 0.5');
        await db.query('ALTER TABLE user_facts ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP');
        await db.query('CREATE INDEX IF NOT EXISTS idx_user_facts_user_updated ON user_facts (user_id, updated_at DESC)');
        await db.query('CREATE INDEX IF NOT EXISTS idx_user_facts_user_relevance ON user_facts (user_id, relevance_score DESC, updated_at DESC)');
        await db.query(`
          CREATE TABLE IF NOT EXISTS user_tasks (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            priority TEXT,
            due_at TIMESTAMP,
            source TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            closed_at TIMESTAMP
          )
        `);
        await db.query('CREATE INDEX IF NOT EXISTS idx_user_tasks_user_status_updated ON user_tasks (user_id, status, updated_at DESC)');
        await db.query(`
          CREATE TABLE IF NOT EXISTS user_files (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            storage_key TEXT,
            url TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            origin TEXT DEFAULT 'upload',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE (user_id, storage_key)
          )
        `);
        await db.query('ALTER TABLE user_files ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT \'upload\'');
        await db.query('ALTER TABLE user_files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()');
        await db.query('ALTER TABLE user_files ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP');
        await db.query('CREATE INDEX IF NOT EXISTS idx_user_files_user_created ON user_files (user_id, created_at DESC)');
        await db.query('CREATE INDEX IF NOT EXISTS idx_user_files_expires_at ON user_files (expires_at)');
        await db.query(`
          CREATE TABLE IF NOT EXISTS conversation_resources (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            resource_kind TEXT NOT NULL DEFAULT 'file',
            origin TEXT DEFAULT 'upload',
            filename TEXT NOT NULL,
            storage_key TEXT NOT NULL,
            url TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            metadata_json JSONB,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE (user_id, conversation_id, storage_key)
          )
        `);
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS resource_kind TEXT NOT NULL DEFAULT \'file\'');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS origin TEXT DEFAULT \'upload\'');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS url TEXT');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS content_type TEXT');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS size_bytes INTEGER');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS metadata_json JSONB');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()');
        await db.query('ALTER TABLE conversation_resources ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP');
        await db.query('CREATE INDEX IF NOT EXISTS idx_conversation_resources_user_conversation_created ON conversation_resources (user_id, conversation_id, created_at DESC)');
        await db.query('CREATE INDEX IF NOT EXISTS idx_conversation_resources_user_kind_updated ON conversation_resources (user_id, resource_kind, updated_at DESC)');
        await db.query('CREATE INDEX IF NOT EXISTS idx_conversation_resources_expires_at ON conversation_resources (expires_at)');

        const adminLookup = await db.query(
          'SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2) LIMIT 1',
          [DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL]
        );
        if (!adminLookup.rows.length) {
          const adminHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
          await db.query(
            'INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3)',
            [DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, adminHash]
          );
          console.log('[AUTH] ✅ Admin bootstrap account created');
        }
        console.log('[DB] ✅ users.reset_token columns vérifiées');
        console.log('[DB] ✅ chat memory tables vérifiées');
        console.log('[DB] ✅ structured memory tables vérifiées');
      } catch (schemaErr) {
        console.warn('[DB] ⚠️ Migration reset token non appliquée:', schemaErr.message);
      }
    })
    .catch(e => console.error('[DB] ❌ Connexion PostgreSQL échouée:', e.message));
} else {
  console.warn('[DB] DATABASE_URL non défini, authentification DB désactivée');
}

function normalizeConversationId(conversationId) {
  const normalized = String(conversationId || '').trim();
  return normalized || 'default';
}

function looksLikeInternalPromptLeak(content) {
  const normalized = String(content || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('# nindo') ||
    normalized.includes('# règles') ||
    normalized.includes('règles strictes') ||
    normalized.includes('tu ne réponds') ||
    normalized.includes('"mode": "actions"') ||
    normalized.includes('"actions": [')
  );
}

async function saveChatMemoryMessage(userId, role, content, conversationId) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedRole = String(role || '').trim().toLowerCase();
  const normalizedContent = typeof content === 'string' ? content.trim() : '';
  if (!db || !normalizedUserId || !normalizedRole || !normalizedContent) return;
  if (normalizedRole === 'assistant' && looksLikeInternalPromptLeak(normalizedContent)) return;

  await db.query(
    'INSERT INTO messages (user_id, conversation_id, role, content) VALUES ($1, $2, $3, $4)',
    [normalizedUserId, normalizedConversationId, normalizedRole, normalizedContent]
  );
}

async function getRecentChatMemory(userId, conversationId, limit = CHAT_MEMORY_LIMIT) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedConversationId = normalizeConversationId(conversationId);
  if (!db || !normalizedUserId) return [];

  const result = await db.query(
    'SELECT role, content, created_at FROM messages WHERE user_id=$1 AND COALESCE(conversation_id, $2)=$2 ORDER BY created_at DESC, id DESC LIMIT $3',
    [normalizedUserId, normalizedConversationId, limit]
  );

  return [...result.rows].reverse().map((row) => ({
    role: String(row.role || 'user'),
    content: String(row.content || '')
  }));
}

async function getLogicalUserMemory(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return '';

  const result = await db.query(
    'SELECT summary FROM user_memory WHERE user_id=$1 LIMIT 1',
    [normalizedUserId]
  );

  return String(result.rows[0]?.summary || '').trim();
}

async function countUserMessages(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return 0;

  const result = await db.query(
    'SELECT COUNT(*)::int AS count FROM messages WHERE user_id=$1 AND role=$2',
    [normalizedUserId, 'user']
  );

  return Number(result.rows[0]?.count || 0);
}

function shouldRefreshLogicalMemory(messageCount) {
  if (!Number.isFinite(messageCount) || messageCount <= 0) return false;
  return messageCount % LOGICAL_MEMORY_UPDATE_EVERY === 0;
}

async function refreshLogicalUserMemory(userId, latestUserMessage, recentMessages) {
  const summaryFlow = getQflushMemorySummaryFlow();
  const normalizedUserId = String(userId || '').trim();
  const normalizedLatestMessage = typeof latestUserMessage === 'string' ? latestUserMessage.trim() : '';

  if (!db || !normalizedUserId || !normalizedLatestMessage) {
    return '';
  }

  const previousSummary = await getLogicalUserMemory(normalizedUserId);
  let summaryResult = null;
  try {
    summaryResult = await runLogicalMemorySummaryFlow({
      flow: summaryFlow,
      userId: normalizedUserId,
      previousSummary,
      latestUserMessage: normalizedLatestMessage,
      recentMessages,
    });
  } catch (error_) {
    console.warn('[A11][memory] logical summary refresh skipped:', error_?.message || error_);
    return previousSummary;
  }

  const nextSummary = extractAssistantText(summaryResult).trim() || previousSummary;
  if (!nextSummary) return '';

  await db.query(
    `INSERT INTO user_memory (user_id, summary, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()`,
    [normalizedUserId, nextSummary]
  );

  return nextSummary;
}

async function pruneChatMemory() {
  if (!db) return;
  await db.query(`DELETE FROM messages WHERE created_at < NOW() - INTERVAL '7 days'`);
}

function normalizeMemoryText(value) {
  return String(value || '').replaceAll(/\s+/g, ' ').trim();
}

function cleanupExtractedValue(value) {
  const normalized = normalizeMemoryText(value).replaceAll(/[\s,.;:!?-]+$/g, '').trim();
  return normalized.slice(0, 240);
}

function execCapture(text, regex, groupIndex = 1) {
  const matcher = regex instanceof RegExp ? regex : null;
  if (!matcher) return '';
  const match = matcher.exec(String(text || ''));
  if (!match) return '';
  return String(match[groupIndex] || '').trim();
}

function parseDateCandidate(raw) {
  const candidate = String(raw || '').trim();
  if (!candidate) return null;

  const isoRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const isoMatch = isoRegex.exec(candidate);
  if (isoMatch) {
    const date = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const frRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const frMatch = frRegex.exec(candidate);
  if (frMatch) {
    const day = frMatch[1].padStart(2, '0');
    const month = frMatch[2].padStart(2, '0');
    const year = frMatch[3];
    const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }

  const parsed = new Date(candidate);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
}

function dedupeByStableKey(items, keyBuilder) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const key = String(keyBuilder(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 0) return 0;
  if (numeric >= 1) return 1;
  return numeric;
}

function getFactTypeWeight(factKey) {
  const key = String(factKey || '').toLowerCase();
  if (key.startsWith('context.project')) return 1;
  if (key.startsWith('profile.')) return 0.95;
  if (key.startsWith('tech.')) return 0.9;
  if (key.startsWith('preferences.')) return 0.85;
  if (key.startsWith('contact.')) return 0.8;
  return 0.65;
}

function computeFactRelevance(fact) {
  const confidence = clamp01(fact?.confidence ?? 0.6);
  const typeWeight = getFactTypeWeight(fact?.key);
  const text = normalizeMemoryText(fact?.value || '');
  const genericPenalty = /\b(ok|merci|thanks|cool|yes|no|lol|haha)\b/i.test(text) ? 0.25 : 0;
  const shortPenalty = text.length < 6 ? 0.2 : 0;

  return clamp01(confidence * 0.65 + typeWeight * 0.35 - genericPenalty - shortPenalty);
}

function extractFactsFromMessage(message) {
  const text = normalizeMemoryText(message);
  if (!text) return [];

  const lower = text.toLowerCase();
  const facts = [];

  const pushFact = (key, value, confidence = 0.7) => {
    const cleaned = cleanupExtractedValue(value);
    if (!cleaned) return;
    facts.push({ key, value: cleaned, confidence, source: 'chat_message' });
  };

  const name = execCapture(text, /\b(?:my name is|i am called|je m'appelle)\s+([^.,!\n]+)/i);
  if (name) pushFact('profile.name', name, 0.9);

  const location = execCapture(text, /\b(?:i live in|j'habite(?: a| en)?|je vis(?: a| en)?)\s+([^.,!\n]+)/i);
  if (location) pushFact('profile.location', location, 0.8);

  const timezone = execCapture(text, /\b(?:my timezone is|timezone|fuseau horaire)\s*[:=]?\s*([^.,!\n]+)/i);
  if (timezone) pushFact('profile.timezone', timezone, 0.8);

  const preference = execCapture(text, /\b(?:i prefer|je prefere|i like|j'aime)\s+([^.!?\n]+)/i);
  if (preference) pushFact('preferences.general', preference, 0.65);

  const email = execCapture(text, /\b(?:my email is|email me at|mon email est)\s+([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (email) pushFact('contact.email', email, 0.95);

  const project = execCapture(text, /\b(?:i work on|je travaille sur|project|projet)\s+([^.!?\n]+)/i);
  if (project) pushFact('context.project', project, 0.6);

  if (lower.includes('node') || lower.includes('javascript')) {
    pushFact('tech.stack_hint', 'node/javascript', 0.55);
  }

  return dedupeByStableKey(facts, (fact) => fact.key);
}

function collectTaskMatches(text, regex) {
  const tasks = [];
  const input = String(text || '');
  const rx = new RegExp(regex.source, regex.flags);
  let match = rx.exec(input);

  while (match !== null) {
    const description = cleanupExtractedValue(match[1]);
    if (description && description.length >= 4) {
      const dueCapture = execCapture(description, /(?:by|avant|pour le|due)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i);
      const dueDate = dueCapture ? parseDateCandidate(dueCapture) : null;
      const closed = /\b(done|termine|completed|fini)\b/i.test(input);

      tasks.push({
        description: description.slice(0, 260),
        status: closed ? 'done' : 'open',
        priority: /\b(urgent|critical|important|prioritaire)\b/i.test(description) ? 'high' : 'normal',
        dueAt: dueDate,
        source: 'chat_message',
      });
    }
    match = rx.exec(input);
  }

  return tasks;
}

function extractTasksFromMessage(message) {
  const text = normalizeMemoryText(message);
  if (!text) return [];

  const taskRegexes = [
    /(?:rappelle[- ]?moi de|remember to|i need to|i must|je dois|il faut que)\s+([^.!?\n]+)/gi,
    /(?:todo|to-do|a faire|task)\s*[:-]?\s*([^\n]+)/gi,
    /(?:next step|prochaine etape)\s*[:-]?\s*([^\n]+)/gi,
  ];

  const tasks = taskRegexes.flatMap((regex) => collectTaskMatches(text, regex));

  return dedupeByStableKey(tasks, (task) => task.description.toLowerCase()).slice(0, 5);
}

async function upsertUserFacts(userId, facts) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId || !Array.isArray(facts) || !facts.length) return;

  for (const fact of facts) {
    const key = normalizeMemoryText(fact?.key).slice(0, 120);
    const value = normalizeMemoryText(fact?.value).slice(0, 500);
    if (!key || !value) continue;

    const confidence = Number.isFinite(Number(fact?.confidence)) ? Number(fact.confidence) : null;
    const relevanceScore = computeFactRelevance(fact);
    const source = normalizeMemoryText(fact?.source || 'chat_message').slice(0, 80);

    await db.query(
      `INSERT INTO user_facts (user_id, fact_key, fact_value, confidence, relevance_score, source, last_seen_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (user_id, fact_key)
       DO UPDATE SET
         fact_value = EXCLUDED.fact_value,
         confidence = COALESCE(EXCLUDED.confidence, user_facts.confidence),
         relevance_score = GREATEST(COALESCE(EXCLUDED.relevance_score, 0), COALESCE(user_facts.relevance_score, 0)),
         source = EXCLUDED.source,
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [normalizedUserId, key, value, confidence, relevanceScore, source]
    );
  }
}

async function markFactsAsUsed(userId, facts) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId || !Array.isArray(facts) || !facts.length) return;

  const keys = facts
    .map((fact) => normalizeMemoryText(fact?.key).slice(0, 120))
    .filter(Boolean);
  if (!keys.length) return;

  await db.query(
    `UPDATE user_facts
     SET last_used_at = NOW()
     WHERE user_id = $1
       AND fact_key = ANY($2::text[])`,
    [normalizedUserId, keys]
  );
}

async function pruneStructuredMemory(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return;

  const factRetentionDays = Math.max(7, FACT_RETENTION_DAYS);
  const taskRetentionDays = Math.max(14, TASK_RETENTION_DAYS);
  const fileRetentionDays = Math.max(14, FILE_RETENTION_DAYS);

  await db.query(
    `DELETE FROM user_facts
     WHERE user_id = $1
       AND (
         relevance_score < $2
         OR updated_at < NOW() - ($3 * INTERVAL '1 day')
       )
       AND COALESCE(last_used_at, updated_at) < NOW() - (GREATEST(7, $3 / 2) * INTERVAL '1 day')`,
    [normalizedUserId, FACT_MIN_RELEVANCE, factRetentionDays]
  );

  await db.query(
    `DELETE FROM user_tasks
     WHERE user_id = $1
       AND status = 'done'
       AND COALESCE(closed_at, updated_at) < NOW() - ($2 * INTERVAL '1 day')`,
    [normalizedUserId, taskRetentionDays]
  );

  await db.query(
    `DELETE FROM user_files
     WHERE user_id = $1
       AND created_at < NOW() - ($2 * INTERVAL '1 day')`,
    [normalizedUserId, fileRetentionDays]
  );
}

async function saveUserTasks(userId, tasks) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId || !Array.isArray(tasks) || !tasks.length) return;

  for (const task of tasks) {
    const description = normalizeMemoryText(task?.description).slice(0, 300);
    if (!description) continue;

    const status = String(task?.status || 'open').trim().toLowerCase();
    const normalizedStatus = ['open', 'in_progress', 'done', 'blocked'].includes(status) ? status : 'open';
    const priority = normalizeMemoryText(task?.priority || 'normal').slice(0, 40);
    const source = normalizeMemoryText(task?.source || 'chat_message').slice(0, 80);
    const dueAt = task?.dueAt instanceof Date && !Number.isNaN(task.dueAt.getTime()) ? task.dueAt.toISOString() : null;

    const existing = await db.query(
      `SELECT id FROM user_tasks
       WHERE user_id=$1
         AND LOWER(TRIM(description))=LOWER(TRIM($2))
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [normalizedUserId, description]
    );

    if (existing.rows.length) {
      await db.query(
        `UPDATE user_tasks
         SET status=$2,
             priority=$3,
             due_at=COALESCE($4::timestamp, due_at),
             source=$5,
             updated_at=NOW(),
             closed_at=CASE WHEN $2='done' THEN NOW() ELSE NULL END
         WHERE id=$1`,
        [existing.rows[0].id, normalizedStatus, priority || null, dueAt, source]
      );
      continue;
    }

    await db.query(
      `INSERT INTO user_tasks (user_id, description, status, priority, due_at, source, created_at, updated_at, closed_at)
       VALUES ($1, $2, $3, $4, $5::timestamp, $6, NOW(), NOW(), CASE WHEN $3='done' THEN NOW() ELSE NULL END)`,
      [normalizedUserId, description, normalizedStatus, priority || null, dueAt, source]
    );
  }
}

async function saveStructuredMemoryFromMessage(userId, message) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedMessage = normalizeMemoryText(message);
  if (!db || !normalizedUserId || !normalizedMessage) return;

  const facts = extractFactsFromMessage(normalizedMessage);
  const tasks = extractTasksFromMessage(normalizedMessage);

  if (facts.length) {
    await upsertUserFacts(normalizedUserId, facts);
  }

  if (tasks.length) {
    await saveUserTasks(normalizedUserId, tasks);
  }
}

function buildTemporaryFileExpiryDate(ttlMs = TEMP_SHARED_FILE_TTL_MS) {
  return new Date(Date.now() + Math.max(60 * 1000, Number(ttlMs || TEMP_SHARED_FILE_TTL_MS)));
}

function normalizeOptionalTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function isResourceExpired(resource) {
  const expiresAt = normalizeOptionalTimestamp(resource?.expiresAt || resource?.expires_at || null);
  return !!(expiresAt && expiresAt.getTime() <= Date.now());
}

async function saveUserFileMemory({ userId, filename, storageKey, url, contentType, sizeBytes, origin, expiresAt }) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedFilename = normalizeMemoryText(filename).slice(0, 220);
  const normalizedStorageKey = normalizeMemoryText(storageKey).slice(0, 500);
  const normalizedUrl = normalizeMemoryText(url).slice(0, 1200);
  const normalizedExpiresAt = normalizeOptionalTimestamp(expiresAt);
  if (!db || !normalizedUserId || !normalizedFilename) return;

  if (normalizedStorageKey) {
    await db.query(
      `INSERT INTO user_files (user_id, filename, storage_key, url, content_type, size_bytes, origin, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (user_id, storage_key)
       DO UPDATE SET
         filename=EXCLUDED.filename,
         url=EXCLUDED.url,
         content_type=EXCLUDED.content_type,
         size_bytes=EXCLUDED.size_bytes,
         origin=EXCLUDED.origin,
         expires_at=EXCLUDED.expires_at,
         updated_at=NOW()`,
      [
        normalizedUserId,
        normalizedFilename,
        normalizedStorageKey,
        normalizedUrl || null,
        normalizeMemoryText(contentType || '').slice(0, 100) || null,
        Number(sizeBytes || 0),
        normalizeMemoryText(origin || 'upload').slice(0, 80) || 'upload',
        normalizedExpiresAt,
      ]
    );
    return;
  }

  await db.query(
    `INSERT INTO user_files (user_id, filename, storage_key, url, content_type, size_bytes, origin, expires_at, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, NOW(), NOW())`,
    [
      normalizedUserId,
      normalizedFilename,
      normalizedUrl || null,
      normalizeMemoryText(contentType || '').slice(0, 100) || null,
      Number(sizeBytes || 0),
      normalizeMemoryText(origin || 'upload').slice(0, 80) || 'upload',
      normalizedExpiresAt,
    ]
  );
}

function normalizeConversationResourceKind(resourceKind) {
  const normalized = String(resourceKind || '').trim().toLowerCase();
  if (normalized === 'artifact') return 'artifact';
  return 'file';
}

function parseConversationResourceMetadata(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function linkConversationResource({
  userId,
  conversationId,
  resourceKind,
  origin,
  filename,
  storageKey,
  url,
  contentType,
  sizeBytes,
  metadata,
  expiresAt,
}) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedFilename = normalizeMemoryText(filename).slice(0, 220);
  const normalizedStorageKey = normalizeMemoryText(storageKey).slice(0, 500);
  const normalizedUrl = normalizeMemoryText(url).slice(0, 1200);
  const normalizedExpiresAt = normalizeOptionalTimestamp(expiresAt);
  if (!db || !normalizedUserId || !normalizedFilename || !normalizedStorageKey) return null;

  const metadataJson = metadata == null ? null : JSON.stringify(metadata);
  const result = await db.query(
    `INSERT INTO conversation_resources (
       user_id,
       conversation_id,
       resource_kind,
       origin,
       filename,
       storage_key,
       url,
       content_type,
       size_bytes,
       metadata_json,
       expires_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW(), NOW())
     ON CONFLICT (user_id, conversation_id, storage_key)
     DO UPDATE SET
       resource_kind=EXCLUDED.resource_kind,
       origin=EXCLUDED.origin,
       filename=EXCLUDED.filename,
       url=EXCLUDED.url,
       content_type=EXCLUDED.content_type,
       size_bytes=EXCLUDED.size_bytes,
       metadata_json=EXCLUDED.metadata_json,
       expires_at=EXCLUDED.expires_at,
       updated_at=NOW()
     RETURNING id, user_id, conversation_id, resource_kind, origin, filename, storage_key, url, content_type, size_bytes, metadata_json, expires_at, created_at, updated_at`,
    [
      normalizedUserId,
      normalizedConversationId,
      normalizeConversationResourceKind(resourceKind),
      normalizeMemoryText(origin || 'upload').slice(0, 80) || 'upload',
      normalizedFilename,
      normalizedStorageKey,
      normalizedUrl || null,
      normalizeMemoryText(contentType || '').slice(0, 100) || null,
      Number(sizeBytes || 0),
      metadataJson,
      normalizedExpiresAt,
    ]
  );

  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    userId: String(row.user_id || ''),
    conversationId: String(row.conversation_id || 'default'),
    resourceKind: String(row.resource_kind || 'file'),
    origin: String(row.origin || ''),
    filename: String(row.filename || ''),
    storageKey: String(row.storage_key || ''),
    url: String(row.url || ''),
    contentType: String(row.content_type || ''),
    sizeBytes: Number(row.size_bytes || 0),
    metadata: parseConversationResourceMetadata(row.metadata_json),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listConversationResources(userId, { conversationId, resourceKind, limit = FILE_MEMORY_LIMIT } = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return [];

  const normalizedConversationId = String(conversationId || '').trim()
    ? normalizeConversationId(conversationId)
    : '';
  const normalizedResourceKind = String(resourceKind || '').trim()
    ? normalizeConversationResourceKind(resourceKind)
    : '';
  const normalizedLimit = Math.max(1, Math.min(100, Number(limit || FILE_MEMORY_LIMIT)));
  const params = [normalizedUserId];
  const conditions = ['user_id=$1'];

  if (normalizedConversationId) {
    params.push(normalizedConversationId);
    conditions.push(`conversation_id=$${params.length}`);
  }

  if (normalizedResourceKind) {
    params.push(normalizedResourceKind);
    conditions.push(`resource_kind=$${params.length}`);
  }

  params.push(normalizedLimit);
  const result = await db.query(
    `SELECT id, user_id, conversation_id, resource_kind, origin, filename, storage_key, url, content_type, size_bytes, metadata_json, expires_at, created_at, updated_at
     FROM conversation_resources
     WHERE ${conditions.join(' AND ')}
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map((row) => ({
    id: Number(row.id || 0),
    userId: String(row.user_id || ''),
    conversationId: String(row.conversation_id || 'default'),
    resourceKind: String(row.resource_kind || 'file'),
    origin: String(row.origin || ''),
    filename: String(row.filename || ''),
    storageKey: String(row.storage_key || ''),
    url: String(row.url || ''),
    contentType: String(row.content_type || ''),
    sizeBytes: Number(row.size_bytes || 0),
    metadata: parseConversationResourceMetadata(row.metadata_json),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function getConversationResourceById(userId, resourceId) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedResourceId = Number(resourceId || 0);
  if (!db || !normalizedUserId || !Number.isFinite(normalizedResourceId) || normalizedResourceId <= 0) return null;

  const result = await db.query(
    `SELECT id, user_id, conversation_id, resource_kind, origin, filename, storage_key, url, content_type, size_bytes, metadata_json, expires_at, created_at, updated_at
     FROM conversation_resources
     WHERE user_id=$1 AND id=$2
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [normalizedUserId, normalizedResourceId]
  );

  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    userId: String(row.user_id || ''),
    conversationId: String(row.conversation_id || 'default'),
    resourceKind: String(row.resource_kind || 'file'),
    origin: String(row.origin || ''),
    filename: String(row.filename || ''),
    storageKey: String(row.storage_key || ''),
    url: String(row.url || ''),
    contentType: String(row.content_type || ''),
    sizeBytes: Number(row.size_bytes || 0),
    metadata: parseConversationResourceMetadata(row.metadata_json),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function markConversationResourceEmailed(userId, resourceId, emailRecord) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedResourceId = Number(resourceId || 0);
  if (!db || !normalizedUserId || !Number.isFinite(normalizedResourceId) || normalizedResourceId <= 0) return null;

  const payload = {
    lastEmailedAt: new Date().toISOString(),
    lastEmail: {
      to: String(emailRecord?.to || '').trim() || null,
      subject: String(emailRecord?.subject || '').trim() || null,
      attached: !!emailRecord?.attached,
      mailId: String(emailRecord?.mailId || '').trim() || null,
      ok: emailRecord?.ok !== false,
    },
  };

  const result = await db.query(
    `UPDATE conversation_resources
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE user_id=$1 AND id=$2
     RETURNING id, metadata_json, updated_at`,
    [normalizedUserId, normalizedResourceId, JSON.stringify(payload)]
  );

  const row = result.rows[0] || null;
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    metadata: parseConversationResourceMetadata(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

function normalizeEmailRecipients(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ));
  }

  const raw = String(value || '').trim();
  if (!raw) return [];
  return Array.from(new Set(
    raw
      .split(/[;,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function normalizeInlineAttachments(rawAttachments) {
  const attachments = [];
  const source = Array.isArray(rawAttachments) ? rawAttachments : [];

  for (const [index, item] of source.entries()) {
    const filename = sanitizeFileName(item?.filename || `attachment-${index + 1}.bin`);
    const contentBase64 = String(item?.contentBase64 || item?.base64 || '').trim();
    if (!contentBase64) {
      const error = new Error('missing_attachment_content');
      error.code = 'missing_attachment_content';
      error.index = index;
      throw error;
    }

    let buffer;
    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch {
      const error = new Error('invalid_attachment_base64');
      error.code = 'invalid_attachment_base64';
      error.index = index;
      throw error;
    }

    if (!buffer || !buffer.length) {
      const error = new Error('empty_attachment');
      error.code = 'empty_attachment';
      error.index = index;
      throw error;
    }

    attachments.push({
      filename,
      contentBase64: buffer.toString('base64'),
    });
  }

  return attachments;
}

function toEmailServiceAttachments(serializedAttachments) {
  return (Array.isArray(serializedAttachments) ? serializedAttachments : []).map((item, index) => ({
    filename: sanitizeFileName(item?.filename || `attachment-${index + 1}.bin`),
    content: Buffer.from(String(item?.contentBase64 || ''), 'base64'),
  }));
}

async function getLatestConversationResource(userId, { conversationId, resourceKind } = {}) {
  const resources = await listConversationResources(userId, {
    conversationId,
    resourceKind,
    limit: 1,
  });
  return resources[0] || null;
}

async function sendPlainEmailNow({
  userId,
  to,
  subject,
  text,
  html,
  attachments,
  conversationId,
  tags,
  logType = 'mail_sent',
}) {
  const recipients = normalizeEmailRecipients(to);
  if (!recipients.length) {
    return { ok: false, error: 'missing_to' };
  }

  const mail = await emailService.sendEmail({
    to: recipients,
    subject,
    text: String(text || '').trim() || (!String(html || '').trim() ? 'Email envoye depuis A11.' : undefined),
    html: String(html || '').trim() || undefined,
    attachments: toEmailServiceAttachments(attachments),
    tags,
  });

  if (mail?.ok === false) {
    return { ok: false, error: mail.reason || 'mail_send_failed', mail };
  }

  appendConversationLog({
    type: logType,
    userId: String(userId || '').trim() || null,
    conversationId: normalizeConversationId(conversationId),
    mail: {
      ...mail,
      to: recipients,
      subject: String(subject || '').trim() || 'A11',
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
    },
  });

  return {
    ok: true,
    conversationId: normalizeConversationId(conversationId),
    mail: {
      ...mail,
      to: recipients,
      subject: String(subject || '').trim() || 'A11',
    },
    attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
  };
}

async function sendConversationResourceEmailNow({
  userId,
  resourceId,
  resource = null,
  to,
  subject,
  message,
  attachToEmail,
}) {
  const recipients = normalizeEmailRecipients(to);
  if (!recipients.length) {
    return { ok: false, error: 'missing_to' };
  }

  const resolvedResource = resource || await getConversationResourceById(userId, resourceId);
  if (!resolvedResource) {
    return { ok: false, error: 'resource_not_found' };
  }

  let attachment = null;
  let attachmentIncluded = false;
  let attachmentFallbackReason = null;
  if (attachToEmail && resolvedResource.storageKey && isR2Configured()) {
    try {
      const downloaded = await downloadBufferFromR2(resolvedResource.storageKey);
      attachment = {
        filename: resolvedResource.filename,
        buffer: downloaded.buffer,
      };
      attachmentIncluded = true;
    } catch (error_) {
      attachmentFallbackReason = String(error_?.message || 'attachment_download_failed');
      console.warn('[RESOURCES] attachment download failed, sending link only:', attachmentFallbackReason);
    }
  } else if (attachToEmail) {
    attachmentFallbackReason = 'attachment_not_available';
  }

  const resolvedSubject = String(subject || '').trim()
    || `A11 — ${resolvedResource.resourceKind === 'artifact' ? 'artefact' : 'fichier'} ${resolvedResource.filename}`;
  const messageLines = [];
  if (String(message || '').trim()) messageLines.push(String(message || '').trim());
  else messageLines.push('A11 t’envoie une ressource depuis ta conversation.');
  if (resolvedResource.conversationId) messageLines.push(`Conversation: ${resolvedResource.conversationId}`);
  if (resolvedResource.metadata?.description) messageLines.push(`Description: ${String(resolvedResource.metadata.description)}`);
  if (attachmentFallbackReason && !attachmentIncluded) {
    messageLines.push('Note: la piece jointe n’a pas pu etre ajoutee, le lien reste disponible.');
  }

  const mail = await sendFileEmail({
    to: recipients,
    subject: resolvedSubject,
    message: messageLines.join('\n\n'),
    fileUrl: resolvedResource.url || null,
    attachment,
  });

  await markConversationResourceEmailed(userId, resolvedResource.id, {
    to: recipients,
    subject: resolvedSubject,
    attached: attachmentIncluded,
    mailId: mail?.id || null,
    ok: mail?.ok !== false,
  });

  appendConversationLog({
    type: 'resource_emailed',
    userId: String(userId || '').trim() || null,
    conversationId: resolvedResource.conversationId || 'default',
    resource: {
      id: resolvedResource.id,
      filename: resolvedResource.filename,
      resourceKind: resolvedResource.resourceKind,
      storageKey: resolvedResource.storageKey,
      url: resolvedResource.url,
    },
    mail: {
      ...mail,
      to: recipients,
      subject: resolvedSubject,
      attachmentIncluded,
      attachmentFallbackReason,
    },
  });

  if (mail?.ok === false) {
    return { ok: false, error: mail.reason || 'resource_email_failed', resource: resolvedResource, mail };
  }

  return {
    ok: true,
    resourceId: resolvedResource.id,
    resource: resolvedResource,
    mail: {
      ...mail,
      to: recipients,
      subject: resolvedSubject,
      attachmentIncluded,
      attachmentFallbackReason,
    },
  };
}

async function sendLatestConversationResourceEmailNow({
  userId,
  conversationId,
  resourceKind,
  to,
  subject,
  message,
  attachToEmail,
}) {
  const latestResource = await getLatestConversationResource(userId, { conversationId, resourceKind });
  if (!latestResource) {
    return { ok: false, error: 'latest_resource_not_found' };
  }

  const sent = await sendConversationResourceEmailNow({
    userId,
    resourceId: latestResource.id,
    resource: latestResource,
    to,
    subject,
    message,
    attachToEmail,
  });

  return {
    ...sent,
    latest: true,
  };
}

const SCHEDULED_MAIL_DIR = path.resolve(
  process.env.A11_SCHEDULED_MAIL_DIR || path.join(__dirname, '.a11_state')
);
const SCHEDULED_MAIL_PATH = path.join(SCHEDULED_MAIL_DIR, 'scheduled-mails.json');
const scheduledMailTimers = new Map();

function ensureScheduledMailStore() {
  fs.mkdirSync(SCHEDULED_MAIL_DIR, { recursive: true });
  if (!fs.existsSync(SCHEDULED_MAIL_PATH)) {
    fs.writeFileSync(SCHEDULED_MAIL_PATH, '[]', 'utf8');
  }
}

function readScheduledMailJobs() {
  ensureScheduledMailStore();
  try {
    const raw = fs.readFileSync(SCHEDULED_MAIL_PATH, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error_) {
    console.warn('[MAIL] scheduled store read failed:', error_?.message);
    return [];
  }
}

function writeScheduledMailJobs(jobs) {
  ensureScheduledMailStore();
  fs.writeFileSync(SCHEDULED_MAIL_PATH, JSON.stringify(Array.isArray(jobs) ? jobs : [], null, 2), 'utf8');
}

function normalizeScheduledMailKind(kind) {
  const normalized = String(kind || 'email').trim().toLowerCase();
  if (normalized === 'resource_email') return 'resource_email';
  if (normalized === 'latest_resource_email') return 'latest_resource_email';
  return 'email';
}

function computeScheduledSendAt({ sendAt, delaySeconds }) {
  if (Number.isFinite(Number(delaySeconds)) && Number(delaySeconds) > 0) {
    return new Date(Date.now() + Number(delaySeconds) * 1000).toISOString();
  }

  const parsed = new Date(String(sendAt || '').trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('invalid_sendAt');
  }
  return parsed.toISOString();
}

function buildScheduledMailJobId() {
  return `mail-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function summarizeScheduledMailJob(job) {
  return {
    id: String(job?.id || ''),
    kind: String(job?.kind || 'email'),
    status: String(job?.status || 'scheduled'),
    sendAt: String(job?.sendAt || ''),
    createdAt: String(job?.createdAt || ''),
    executedAt: job?.executedAt || null,
    cancelledAt: job?.cancelledAt || null,
    conversationId: job?.conversationId || null,
    to: Array.isArray(job?.to) ? job.to : normalizeEmailRecipients(job?.to),
    subject: job?.subject || null,
    attachmentCount: Array.isArray(job?.attachments) ? job.attachments.length : 0,
    resourceId: Number(job?.resourceId || 0) || null,
    resourceKind: job?.resourceKind || null,
    error: job?.error || null,
    result: job?.result || null,
  };
}

async function executeScheduledMailJob(jobId) {
  const jobs = readScheduledMailJobs();
  const index = jobs.findIndex((job) => job?.id === jobId);
  if (index < 0) return null;

  const job = jobs[index];
  if (job.status !== 'scheduled') return summarizeScheduledMailJob(job);

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  jobs[index] = job;
  writeScheduledMailJobs(jobs);

  try {
    let result = null;
    if (job.kind === 'email') {
      result = await sendPlainEmailNow({
        userId: job.userId,
        to: job.to,
        subject: job.subject,
        text: job.message,
        html: job.html,
        attachments: job.attachments,
        conversationId: job.conversationId,
        tags: [{ name: 'type', value: 'scheduled_email' }],
        logType: 'mail_sent',
      });
    } else if (job.kind === 'resource_email') {
      result = await sendConversationResourceEmailNow({
        userId: job.userId,
        resourceId: job.resourceId,
        to: job.to,
        subject: job.subject,
        message: job.message,
        attachToEmail: job.attachToEmail,
      });
    } else if (job.kind === 'latest_resource_email') {
      result = await sendLatestConversationResourceEmailNow({
        userId: job.userId,
        conversationId: job.conversationId,
        resourceKind: job.resourceKind,
        to: job.to,
        subject: job.subject,
        message: job.message,
        attachToEmail: job.attachToEmail,
      });
    } else {
      throw new Error(`unsupported_scheduled_mail_kind:${job.kind}`);
    }

    if (!result?.ok) {
      throw new Error(result?.error || 'scheduled_mail_failed');
    }

    job.status = 'sent';
    job.executedAt = new Date().toISOString();
    job.result = result;
    job.error = null;
  } catch (error_) {
    job.status = 'failed';
    job.executedAt = new Date().toISOString();
    job.error = String(error_?.message || error_);
  }

  jobs[index] = job;
  writeScheduledMailJobs(jobs);
  return summarizeScheduledMailJob(job);
}

function scheduleMailTimer(job) {
  if (!job?.id) return;
  const existing = scheduledMailTimers.get(job.id);
  if (existing) clearTimeout(existing);
  scheduledMailTimers.delete(job.id);

  if (job.status !== 'scheduled') return;

  const runAtMs = new Date(job.sendAt).getTime();
  if (!Number.isFinite(runAtMs)) return;

  const remaining = runAtMs - Date.now();
  const maxDelay = 2147483647;
  const delay = Math.max(0, Math.min(maxDelay, remaining));
  const timer = setTimeout(async () => {
    scheduledMailTimers.delete(job.id);
    if (runAtMs - Date.now() > 1000) {
      scheduleMailTimer(job);
      return;
    }
    try {
      await executeScheduledMailJob(job.id);
    } catch (error_) {
      console.warn('[MAIL] scheduled execution failed:', error_?.message);
    }
  }, delay);
  scheduledMailTimers.set(job.id, timer);
}

function bootstrapScheduledMailJobs() {
  const jobs = readScheduledMailJobs();
  for (const job of jobs) {
    if (job?.status === 'scheduled') {
      scheduleMailTimer(job);
    }
  }
}

function buildMemorySystemMessage(logicalMemory, structuredMemoryContext, conversationResourceContext) {
  const parts = [];
  if (logicalMemory) {
    parts.push(`Contexte utilisateur (memoire logique):\n${logicalMemory}`);
  }
  if (structuredMemoryContext) {
    parts.push(structuredMemoryContext);
  }
  if (conversationResourceContext) {
    parts.push(conversationResourceContext);
  }

  if (!parts.length) return null;
  return {
    role: 'system',
    content: parts.join('\n\n'),
  };
}

async function getUserFacts(userId, limit = FACT_MEMORY_LIMIT) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return [];

  const normalizedLimit = Math.max(1, Math.min(50, Number(limit || FACT_MEMORY_LIMIT)));
  const result = await db.query(
    `SELECT fact_key, fact_value, confidence, relevance_score, source, updated_at, last_used_at
     FROM user_facts
     WHERE user_id=$1
       AND COALESCE(relevance_score, 0.5) >= $3
     ORDER BY COALESCE(relevance_score, 0.5) DESC,
              COALESCE(last_used_at, updated_at) DESC,
              updated_at DESC,
              id DESC
     LIMIT $2`,
    [normalizedUserId, normalizedLimit, FACT_MIN_RELEVANCE]
  );

  return result.rows.map((row) => ({
    key: String(row.fact_key || ''),
    value: String(row.fact_value || ''),
    confidence: Number(row.confidence || 0),
    relevanceScore: Number(row.relevance_score || 0.5),
    source: String(row.source || ''),
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }));
}

async function getUserTasks(userId, limit = TASK_MEMORY_LIMIT) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return [];

  const normalizedLimit = Math.max(1, Math.min(50, Number(limit || TASK_MEMORY_LIMIT)));
  const result = await db.query(
    `SELECT id, description, status, priority, due_at, source, updated_at
     FROM user_tasks
     WHERE user_id=$1
     ORDER BY CASE WHEN status='open' THEN 0 WHEN status='in_progress' THEN 1 WHEN status='blocked' THEN 2 ELSE 3 END,
              updated_at DESC,
              id DESC
     LIMIT $2`,
    [normalizedUserId, normalizedLimit]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    description: String(row.description || ''),
    status: String(row.status || 'open'),
    priority: String(row.priority || 'normal'),
    dueAt: row.due_at,
    source: String(row.source || ''),
    updatedAt: row.updated_at,
  }));
}

async function getUserFilesMemory(userId, limit = FILE_MEMORY_LIMIT) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) return [];

  const normalizedLimit = Math.max(1, Math.min(50, Number(limit || FILE_MEMORY_LIMIT)));
  const result = await db.query(
    `SELECT filename, storage_key, url, content_type, size_bytes, origin, expires_at, created_at
     FROM user_files
     WHERE user_id=$1
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [normalizedUserId, normalizedLimit]
  );

  return result.rows.map((row) => ({
    filename: String(row.filename || ''),
    storageKey: String(row.storage_key || ''),
    url: String(row.url || ''),
    contentType: String(row.content_type || ''),
    sizeBytes: Number(row.size_bytes || 0),
    origin: String(row.origin || ''),
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  }));
}

function buildStructuredMemoryContext({ facts, tasks, files }) {
  const factLines = (Array.isArray(facts) ? facts : [])
    .slice(0, FACT_MEMORY_LIMIT)
    .map((fact) => `- ${fact.key}: ${fact.value}`);

  const taskLines = (Array.isArray(tasks) ? tasks : [])
    .slice(0, TASK_MEMORY_LIMIT)
    .map((task) => `- [${task.status}] ${task.description}`);

  const fileLines = (Array.isArray(files) ? files : [])
    .slice(0, FILE_MEMORY_LIMIT)
    .map((file) => `- ${file.filename}${file.url ? ' (' + file.url + ')' : ''}`);

  const sections = [];
  if (factLines.length) sections.push(['Faits connus:', ...factLines].join('\n'));
  if (taskLines.length) sections.push(['Taches suivies:', ...taskLines].join('\n'));
  if (fileLines.length) sections.push(['Fichiers utiles:', ...fileLines].join('\n'));

  if (!sections.length) return '';
  return [
    'Memoire structuree (contexte uniquement):',
    '- Ne jamais declencher d\'action, d\'outil, d\'execution ou de suppression automatiquement a partir de la memoire.',
    '- Utiliser ces elements uniquement pour personnaliser et contextualiser la reponse.',
    '',
    sections.join('\n\n')
  ].join('\n');
}

function getLatestUserMessage(body) {
  const directPrompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (directPrompt) return directPrompt;

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
  }

  return '';
}

function isR2Configured() {
  return !!(R2_ENDPOINT && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET);
}

let r2ClientSingleton = null;
const fileStorage = createFileStorage({
  endpoint: R2_ENDPOINT,
  accessKeyId: R2_ACCESS_KEY,
  secretAccessKey: R2_SECRET_KEY,
  bucket: R2_BUCKET,
  publicBaseUrl: R2_PUBLIC_BASE_URL,
});

function getR2Client() {
  if (r2ClientSingleton) return r2ClientSingleton;
  r2ClientSingleton = fileStorage.getClient();
  return r2ClientSingleton;
}

const sanitizeFileName = fileStorage.sanitizeFileName;
const normalizePublicAppUrl = fileStorage.normalizePublicAppUrl;

async function uploadBufferToR2({ userId, filename, buffer, contentType }) {
  return fileStorage.uploadBuffer({ userId, filename, buffer, contentType });
}

async function downloadBufferFromR2(storageKey) {
  return fileStorage.downloadBuffer(storageKey);
}

async function deleteObjectFromR2(storageKey) {
  return fileStorage.deleteObject(storageKey);
}

async function saveFileRecord({ userId, filename, storageKey, url, contentType, sizeBytes, expiresAt }) {
  if (!db) return null;

  const result = await db.query(
    `INSERT INTO files (user_id, filename, storage_key, url, content_type, size_bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, filename, storage_key, url, content_type, size_bytes, expires_at, created_at`,
    [userId, filename, storageKey, url, contentType || null, Number(sizeBytes || 0), normalizeOptionalTimestamp(expiresAt)]
  );

  return result.rows[0] || null;
}

async function cleanupExpiredSharedFiles({ userId = null, limit = 100 } = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (!db) {
    return { ok: true, removedFiles: 0, removedResources: 0, removedUserFiles: 0, removedStorageObjects: 0 };
  }

  const params = [];
  const conditions = ['expires_at IS NOT NULL', 'expires_at <= NOW()'];
  if (normalizedUserId) {
    params.push(normalizedUserId);
    conditions.push(`user_id=$${params.length}`);
  }
  params.push(Math.max(1, Math.min(500, Number(limit || 100))));

  const expired = await db.query(
    `SELECT id, user_id, storage_key
     FROM files
     WHERE ${conditions.join(' AND ')}
     ORDER BY expires_at ASC, id ASC
     LIMIT $${params.length}`,
    params
  );

  const rows = expired.rows || [];
  if (!rows.length) {
    return { ok: true, removedFiles: 0, removedResources: 0, removedUserFiles: 0, removedStorageObjects: 0 };
  }

  const fileIds = rows
    .map((row) => Number(row.id || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const storageKeys = Array.from(new Set(
    rows.map((row) => String(row.storage_key || '').trim()).filter(Boolean)
  ));
  const deletedKeys = [];

  for (const storageKey of storageKeys) {
    try {
      await deleteObjectFromR2(storageKey);
      deletedKeys.push(storageKey);
    } catch (error_) {
      console.warn('[FILES] expired object cleanup failed:', storageKey, error_?.message);
    }
  }

  await db.query('BEGIN');
  try {
    let removedResources = { rowCount: 0 };
    let removedUserFiles = { rowCount: 0 };
    if (storageKeys.length) {
      removedResources = await db.query(
        'DELETE FROM conversation_resources WHERE storage_key = ANY($1::text[]) AND expires_at IS NOT NULL AND expires_at <= NOW()',
        [storageKeys]
      );
      removedUserFiles = await db.query(
        'DELETE FROM user_files WHERE storage_key = ANY($1::text[]) AND expires_at IS NOT NULL AND expires_at <= NOW()',
        [storageKeys]
      );
    }

    const removedFiles = fileIds.length
      ? await db.query('DELETE FROM files WHERE id = ANY($1::int[])', [fileIds])
      : { rowCount: 0 };

    await db.query('COMMIT');
    return {
      ok: true,
      removedFiles: Number(removedFiles.rowCount || 0),
      removedResources: Number(removedResources.rowCount || 0),
      removedUserFiles: Number(removedUserFiles.rowCount || 0),
      removedStorageObjects: deletedKeys.length,
    };
  } catch (error_) {
    try { await db.query('ROLLBACK'); } catch {}
    throw error_;
  }
}

let expiredSharedFilesCleanupTimer = globalThis.__A11_EXPIRED_SHARED_FILES_CLEANUP_TIMER || null;
function ensureExpiredSharedFilesCleanupTimer() {
  if (!db || expiredSharedFilesCleanupTimer) return;
  expiredSharedFilesCleanupTimer = setInterval(() => {
    cleanupExpiredSharedFiles({ limit: 200 }).catch((error_) => {
      console.warn('[FILES] scheduled expired cleanup failed:', error_?.message);
    });
  }, TEMP_SHARED_FILE_CLEANUP_INTERVAL_MS);
  if (typeof expiredSharedFilesCleanupTimer?.unref === 'function') {
    expiredSharedFilesCleanupTimer.unref();
  }
  globalThis.__A11_EXPIRED_SHARED_FILES_CLEANUP_TIMER = expiredSharedFilesCleanupTimer;

  setTimeout(() => {
    cleanupExpiredSharedFiles({ limit: 200 }).catch((error_) => {
      console.warn('[FILES] startup expired cleanup failed:', error_?.message);
    });
  }, 10_000);
}

ensureExpiredSharedFilesCleanupTimer();

// ============================================================
// Email providers
// Priority: Resend API, then SMTP/Gmail fallback
// ============================================================
const emailService = createEmailService({
  resendApiKey: process.env.RESEND_API_KEY,
  fromEmail: process.env.EMAIL_FROM || 'A11 <onboarding@resend.dev>',
  appUrl: normalizePublicAppUrl(process.env.APP_URL || process.env.FRONT_URL || 'https://a11.funesterie.pro'),
});
const resendClient = emailService.isConfigured();
if (resendClient) {
  console.log('[MAIL] ✅ Resend provider activé');
} else {
  console.warn('[MAIL] Aucun provider mail configuré (RESEND_API_KEY manquant)');
}

async function sendFileEmail({ to, subject, message, fileUrl, attachment }) {
  return emailService.sendFileEmail({ to, subject, message, fileUrl, attachment });
}

bootstrapScheduledMailJobs();

// Ajout express.json AVANT les proxies pour garantir le body POST
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/tts', express.static(path.join(__dirname, '../../public/tts')));

// SUPPRESSION des premiers express.json / express.urlencoded
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));

// Routes OpenAI / LLM classiques
registerOpenAIRoutes(router);

// Routes A11Host (VSIX + headless)
const a11HostRouter = Router();
a11HostRouter.use('/v1/vs', (req, res, next) => verifyJWT(req, res, next));
registerA11HostRoutes(a11HostRouter);
router.use(a11HostRouter);

// Monter le router principal sous /api
app.use('/api', router);

// Monter les routes TTS (Piper) sous /api aussi
try {
  const ttsRouter = require('./routes/tts.cjs');   // ← c'est déjà un express.Router()
  app.use('/api', ttsRouter);
  console.log('[Server] TTS routes mounted under /api');
} catch ( e) {
  console.warn('[Server] Failed to register TTS routes:', e?.message);
}

// ✅ LOGIN ROUTE (public, no auth required)
// ✅ JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = '24h';

// ⚠️ SECURITY WARNING: si JWT_SECRET est le default, on log un warning en prod
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-secret-change-in-production') {
  console.error('[SECURITY] ⚠️⚠️⚠️ JWT_SECRET is set to DEFAULT - SET IT IN PRODUCTION! ⚠️⚠️⚠️');
  console.error('[SECURITY] Si tu deploys sur Railway: ajoute JWT_SECRET dans les variables d\'env');
}

// ✅ JWT verification middleware
function verifyJWT(req, res, next) {
  const token = req.headers['x-nez-token'] || req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    console.warn('[JWT] No token provided');
    return res.status(401).json({
      error: 'A11_JWT_Missing',
      message: 'JWT token manquant'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    console.log('[JWT] ✅ Token vérifié');
    next();
  } catch (err) {
    console.warn('[JWT] Verification failed:', err.message);
    return res.status(401).json({
      error: 'A11_JWT_Invalid',
      message: `JWT invalide ou expiré: ${err.message}`
    });
  }
}

app.get('/api/a11host/status', verifyJWT, async (_req, res) => {
  try {
    const status = await getA11HostStatus();
    res.json(status);
  } catch (err) {
    console.warn('[A11Host] Protected status failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/a11/capabilities', verifyJWT, async (_req, res) => {
  try {
    const supervisor = globalThis.__A11_SUPERVISOR || globalThis.__A11_QFLUSH_SUPERVISOR || null;
    const a11host = await getA11HostCapabilities();
    const qflushStatus = qflushIntegration.getStatus(supervisor);
    const processes = {};
    for (const [name, proc] of Object.entries(qflushStatus.processes || {})) {
      processes[name] = {
        status: proc?.status || 'unknown',
        pid: proc?.pid || null,
        restarts: proc?.restarts || 0,
        uptime: proc?.uptime ?? null
      };
    }

    res.json({
      ok: true,
      a11host,
      qflush: {
        available: !!qflushStatus.available,
        error: qflushStatus.error || null,
        processes
      }
    });
  } catch (err) {
    console.warn('[A11] Capabilities route failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/control/status', verifyJWT, async (req, res) => {
  try {
    const status = await buildControlCenterStatus(req);
    res.json(status);
  } catch (err) {
    console.warn('[A11] Control status failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/control/:command', verifyJWT, requireRuntimeControlAccess, async (req, res) => {
  try {
    const command = String(req.params.command || '').trim().toLowerCase();
    const target = String(req.body?.target || '').trim().toLowerCase();
    const supervisor = getSupervisorInstance();
    if (!supervisor) {
      return res.status(503).json({
        ok: false,
        error: 'supervisor_unavailable',
        message: 'Supervisor local indisponible.',
      });
    }

    if (!['start', 'stop', 'restart'].includes(command)) {
      return res.status(400).json({
        ok: false,
        error: 'unsupported_command',
        message: 'Commande non supportee.',
      });
    }

    const availableTargets = Object.keys(qflushIntegration.getStatus(supervisor)?.processes || {});
    if (!availableTargets.length) {
      return res.status(503).json({
        ok: false,
        error: 'no_supervised_targets',
        message: 'Aucun service supervise n est disponible sur ce backend.',
      });
    }

    const targets = target === 'stack' ? availableTargets : [target];
    const invalidTargets = targets.filter((candidate) => !availableTargets.includes(candidate));
    if (invalidTargets.length) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_target',
        message: `Cible invalide: ${invalidTargets.join(', ')}`,
        availableTargets,
      });
    }

    const results = [];
    for (const currentTarget of targets) {
      try {
        let actionOk = false;
        if (command === 'start') {
          actionOk = await qflushIntegration.startProcess(supervisor, currentTarget);
        } else if (command === 'stop') {
          actionOk = await qflushIntegration.stopProcess(supervisor, currentTarget);
        } else {
          actionOk = await qflushIntegration.restartProcess(supervisor, currentTarget);
        }

        results.push({
          target: currentTarget,
          ok: !!actionOk,
          message: actionOk ? `${command} demande` : `${command} refuse ou non disponible`,
        });
      } catch (error_) {
        results.push({
          target: currentTarget,
          ok: false,
          message: String(error_?.message || error_),
        });
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await buildControlCenterStatus(req);

    res.json({
      ok: results.every((entry) => entry.ok),
      action: command,
      target: target || 'stack',
      results,
      status,
    });
  } catch (err) {
    console.warn('[A11] Control action failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function isAdminRequest(req) {
  const configuredAdminToken = String(process.env.NEZ_ADMIN_TOKEN || '').trim();
  const adminHeader = String(req.headers['x-nez-admin'] || '').trim();
  if (configuredAdminToken && adminHeader && adminHeader === configuredAdminToken) {
    return true;
  }

  const userId = String(req.user?.id || '').trim().toLowerCase();
  const username = String(req.user?.username || '').trim().toLowerCase();
  const normalizedDefaultAdmin = DEFAULT_ADMIN_USERNAME.toLowerCase();
  return userId === 'admin' || username === 'admin' || username === normalizedDefaultAdmin;
}

function getSupervisorInstance() {
  return globalThis.__A11_SUPERVISOR || globalThis.__A11_QFLUSH_SUPERVISOR || null;
}

function isLocalControlOrigin(req) {
  const requestOrigin = String(getRequestOrigin(req) || '').toLowerCase();
  const requestHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const candidates = [requestOrigin, requestHost].filter(Boolean);
  return candidates.some((value) =>
    value.includes('127.0.0.1') ||
    value.includes('localhost') ||
    value.includes('api.funesterie.me')
  );
}

function requireRuntimeControlAccess(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({
      ok: false,
      error: 'admin_required',
      message: 'Controle runtime reserve au compte admin.',
    });
  }

  if (!isLocalControlOrigin(req)) {
    return res.status(403).json({
      ok: false,
      error: 'local_control_only',
      message: 'Les actions start/stop/restart sont autorisees uniquement via le backend local ou tunnelé.',
    });
  }

  return next();
}

async function getLlmStatsSnapshot() {
  const port = Number(process.env.PORT || 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const response = await fetch(`${baseUrl}/api/llm/stats`, {
    method: 'GET',
    signal: AbortSignal.timeout(4000),
  });
  const raw = await response.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw: String(raw).slice(0, 400) };
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function toControlServiceState(value, fallback = 'warning') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'running' || normalized === 'ready' || normalized === 'online' || normalized === 'ok') {
    return 'online';
  }
  if (normalized === 'registered' || normalized === 'starting' || normalized === 'booting') {
    return 'starting';
  }
  if (normalized === 'stopped' || normalized === 'dead' || normalized === 'offline' || normalized === 'down') {
    return 'offline';
  }
  return fallback;
}

function buildSupervisorServiceCard(target, processInfo, controlEnabled) {
  const actions = controlEnabled ? ['start', 'restart', 'stop'] : [];
  return {
    id: target,
    label: target === 'cerbere'
      ? 'Cerbere / LLM Router'
      : target === 'tts'
        ? 'TTS / SIWIS'
        : target === 'llama-server'
          ? 'Llama Server'
          : target,
    state: toControlServiceState(processInfo?.status, 'warning'),
    detail: `status ${processInfo?.status || 'unknown'} · pid ${processInfo?.pid || '—'} · restarts ${processInfo?.restarts || 0}`,
    actions,
    meta: {
      pid: processInfo?.pid || null,
      restarts: processInfo?.restarts || 0,
      uptime: processInfo?.uptime ?? null,
      autoRestart: processInfo?.autoRestart ?? null,
    },
  };
}

async function buildControlCenterStatus(req) {
  const controlEnabled = isLocalControlOrigin(req) && isAdminRequest(req);
  const supervisor = getSupervisorInstance();
  const qflushStatus = qflushIntegration.getStatus(supervisor);
  const runtime = getPublicRuntimeStatus({
    config: buildRuntimeConfig(process.env),
    hasDb: Boolean(db),
    isR2Configured: isR2Configured(),
    hasResend: emailService.isConfigured(),
    hasQflush: Boolean(QFLUSH_AVAILABLE),
  });

  const [a11host, ttsSnapshot, llmSnapshot] = await Promise.all([
    getA11HostStatus().catch((error_) => ({ ok: false, available: false, error: String(error_?.message || error_) })),
    getSiwisHealthSnapshot().catch((error_) => ({ ok: false, status: 503, body: { error: String(error_?.message || error_) } })),
    getLlmStatsSnapshot().catch((error_) => ({ ok: false, status: 503, body: { error: String(error_?.message || error_) } })),
  ]);

  const requestOrigin = getRequestOrigin(req);
  const availableTargets = Object.keys(qflushStatus?.processes || {});
  const services = [];

  services.push({
    id: 'backend',
    label: 'Backend A11',
    state: 'online',
    detail: `API active · DB ${runtime?.integrations?.database ? 'ok' : 'off'} · R2 ${runtime?.integrations?.r2?.configured ? 'ok' : 'off'}`,
    url: requestOrigin || runtime?.config?.publicApiUrl || null,
    actions: [],
    meta: runtime?.config || {},
  });

  services.push({
    id: 'tts-http',
    label: 'TTS / SIWIS',
    state: ttsSnapshot?.ok && ttsSnapshot?.body?.ok ? 'online' : 'offline',
    detail: ttsSnapshot?.ok && ttsSnapshot?.body?.ok
      ? `mode ${ttsSnapshot.body.mode || 'http'}`
      : `indisponible (${String(ttsSnapshot?.body?.error || ttsSnapshot?.status || 'unknown')})`,
    url: runtime?.config?.tts?.publicBaseUrl || runtime?.config?.tts?.internalUrl || null,
    actions: [],
    meta: ttsSnapshot?.body || {},
  });

  services.push({
    id: 'llm-router',
    label: 'Cerbere / LLM',
    state: llmSnapshot?.ok ? 'online' : 'offline',
    detail: llmSnapshot?.ok
      ? `mode ${llmSnapshot?.body?.mode || 'ok'}`
      : `indisponible (${String(llmSnapshot?.body?.error || llmSnapshot?.status || 'unknown')})`,
    url: String(process.env.LLM_ROUTER_URL || '').trim() || null,
    actions: [],
    meta: llmSnapshot?.body || {},
  });

  services.push({
    id: 'qflush-runtime',
    label: 'Qflush',
    state: qflushStatus?.available ? 'online' : 'warning',
    detail: qflushStatus?.available
      ? `flow ${qflushStatus?.chatFlow || 'non configure'}`
      : String(qflushStatus?.error || qflushStatus?.message || 'non initialise'),
    url: qflushStatus?.remoteUrl || process.env.QFLUSH_URL || null,
    actions: [],
    meta: qflushStatus || {},
  });

  services.push({
    id: 'a11host',
    label: 'A11Host',
    state: a11host?.available ? 'online' : 'warning',
    detail: a11host?.available
      ? `mode ${a11host?.mode || 'connected'}`
      : String(a11host?.error || 'bridge indisponible'),
    url: null,
    actions: [],
    meta: a11host || {},
  });

  for (const [target, processInfo] of Object.entries(qflushStatus?.processes || {})) {
    services.push(buildSupervisorServiceCard(target, processInfo, controlEnabled));
  }

  return {
    ok: true,
    profile: {
      key: isLocalControlOrigin(req) ? 'local' : 'online',
      label: isLocalControlOrigin(req) ? 'Local tunnel' : 'Online',
      requestOrigin,
      frontendUrl: runtime?.config?.frontendUrl || 'https://a11.funesterie.pro',
      publicApiUrl: runtime?.config?.publicApiUrl || requestOrigin || '',
      controlEnabled,
      controlReason: controlEnabled
        ? 'Actions start/stop/restart autorisees sur ce backend.'
        : 'Statuts consultables ici. Les actions runtime sont reservees au backend local/tunnelé.',
      availableTargets,
    },
    runtime,
    supervisor: {
      available: !!qflushStatus?.available,
      processes: qflushStatus?.processes || {},
    },
    services,
  };
}

async function getStructuredMemoryCounts(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) {
    return { facts: 0, tasks: 0, files: 0 };
  }

  const [factsRes, tasksRes, filesRes] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS count FROM user_facts WHERE user_id=$1', [normalizedUserId]),
    db.query('SELECT COUNT(*)::int AS count FROM user_tasks WHERE user_id=$1', [normalizedUserId]),
    db.query('SELECT COUNT(*)::int AS count FROM user_files WHERE user_id=$1', [normalizedUserId]),
  ]);

  return {
    facts: Number(factsRes.rows[0]?.count || 0),
    tasks: Number(tasksRes.rows[0]?.count || 0),
    files: Number(filesRes.rows[0]?.count || 0),
  };
}

async function getStructuredMemoryPurgeCandidates(userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!db || !normalizedUserId) {
    return { facts: 0, tasks: 0, files: 0 };
  }

  const factRetentionDays = Math.max(7, FACT_RETENTION_DAYS);
  const taskRetentionDays = Math.max(14, TASK_RETENTION_DAYS);
  const fileRetentionDays = Math.max(14, FILE_RETENTION_DAYS);

  const [factsRes, tasksRes, filesRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS count
       FROM user_facts
       WHERE user_id = $1
         AND (
           relevance_score < $2
           OR updated_at < NOW() - ($3 * INTERVAL '1 day')
         )
         AND COALESCE(last_used_at, updated_at) < NOW() - (GREATEST(7, $3 / 2) * INTERVAL '1 day')`,
      [normalizedUserId, FACT_MIN_RELEVANCE, factRetentionDays]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
       FROM user_tasks
       WHERE user_id = $1
         AND status = 'done'
         AND COALESCE(closed_at, updated_at) < NOW() - ($2 * INTERVAL '1 day')`,
      [normalizedUserId, taskRetentionDays]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
       FROM user_files
       WHERE user_id = $1
         AND created_at < NOW() - ($2 * INTERVAL '1 day')`,
      [normalizedUserId, fileRetentionDays]
    ),
  ]);

  return {
    facts: Number(factsRes.rows[0]?.count || 0),
    tasks: Number(tasksRes.rows[0]?.count || 0),
    files: Number(filesRes.rows[0]?.count || 0),
  };
}

// ✅ LOGIN ROUTE - renvoie un JWT signé
// ✅ REGISTER
app.post('/api/auth/register', express.json(), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { username, email, password } = req.body || {};
  const normalizedUsername = String(username || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedUsername || !normalizedEmail || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, email',
      [normalizedUsername, normalizedEmail, hash]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    console.log('[AUTH] ✅ Register:', normalizedUsername);
    res.json({
      ok: true,
      success: true,
      token,
      expiresIn: JWT_EXPIRY,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (e) {
    console.warn('[AUTH] Register failed:', e.message);
    const message = String(e?.message || '');
    const detail = String(e?.detail || '');
    const combined = `${message} ${detail}`.toLowerCase();
    let error = 'User already exists';
    if (combined.includes('username')) error = 'username_taken';
    else if (combined.includes('email')) error = 'email_taken';
    res.status(400).json({ error });
  }
});

// ✅ LOGIN - renvoie un JWT signé
app.post('/api/auth/login', express.json(), async (req, res) => {
  const { email, username, password } = req.body || {};
  const identifier = String(email || username || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  console.log('[AUTH] Login attempt received');

  if (!identifier || !password) {
    return res.status(400).json({ success: false, error: 'Missing credentials' });
  }

  // Fallback hardcodé si pas de DB (dev sans DATABASE_URL)
  if (!db) {
    const { username: u, password: p } = req.body || {};
    const normalizedFallbackUser = String(u || '').trim().toLowerCase();
    const fallbackDefaultAdmin = DEFAULT_ADMIN_USERNAME.toLowerCase();
    const isLegacyAdmin = normalizedFallbackUser === 'admin' && p === '1234';
    const isDefaultAdmin = normalizedFallbackUser === fallbackDefaultAdmin && p === DEFAULT_ADMIN_PASSWORD;
    if (isLegacyAdmin || isDefaultAdmin) {
      const resolvedUsername = isLegacyAdmin ? 'admin' : DEFAULT_ADMIN_USERNAME;
      const token = jwt.sign({ username: resolvedUsername, id: resolvedUsername.toLowerCase() }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      return res.json({ success: true, token, user: { id: resolvedUsername.toLowerCase(), username: resolvedUsername } });
    }
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE LOWER(email)=LOWER($1) OR username=$1 LIMIT 1',
      [normalizedEmail || identifier]
    );
    if (!rows.length) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    console.log('[AUTH] ✅ Login réussi');
    res.json({ success: true, token, user: { id: user.id, username: user.username } });
  } catch (e) {
    console.error('[AUTH] Login error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ FORGOT PASSWORD
const forgotPasswordHandler = async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { email } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return res.status(400).json({ error: 'Missing email' });
  if (!emailService.isConfigured()) {
    console.warn('[AUTH] Forgot requested but email transport is not configured');
    return res.json({ ok: true, mailEnabled: false });
  }
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email)=LOWER($1)', [normalizedEmail]);
    // Toujours répondre ok pour ne pas révéler si l'email existe
    if (!rows.length) {
      console.warn('[AUTH] Forgot requested for unknown email');
      return res.json({ ok: true });
    }
    const user = rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await db.query(
      'UPDATE users SET reset_token=$1, reset_token_expires_at=$2 WHERE id=$3',
      [resetToken, expiresAt, user.id]
    );

    const appUrl = emailService.getStatus().appUrl || normalizePublicAppUrl(process.env.APP_URL || process.env.FRONT_URL || 'https://a11.funesterie.pro');
    const link = `${appUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const mailResult = await emailService.sendPasswordResetEmail({
      to: user.email,
      link,
    });
    if (!mailResult?.ok) throw new Error(mailResult?.reason || 'mail_send_failed');
    console.log('[AUTH] ✅ Reset email envoyé');
    res.json({ ok: true, mailEnabled: true });
  } catch (e) {
    console.error('[AUTH] Forgot error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
};

app.post('/api/auth/forgot', express.json(), forgotPasswordHandler);
app.post('/api/auth/forgot-password', express.json(), forgotPasswordHandler);

// ✅ RESET PASSWORD
const resetPasswordHandler = async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  const { token, password, newPassword } = req.body || {};
  const effectivePassword = String(password || newPassword || '');
  if (!token || !effectivePassword) return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = await bcrypt.hash(effectivePassword, 10);

    // New flow: DB token with expiration
    const byResetToken = await db.query(
      'SELECT id FROM users WHERE reset_token=$1 AND reset_token_expires_at > NOW() LIMIT 1',
      [token]
    );

    if (byResetToken.rows.length) {
      const userId = byResetToken.rows[0].id;
      await db.query(
        'UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires_at=NULL WHERE id=$2',
        [hash, userId]
      );
      console.log('[AUTH] ✅ Password reset via DB token');
      return res.json({ ok: true });
    }

    // Backward compatibility: previous JWT reset token format
    const decoded = jwt.verify(token, JWT_SECRET);
    await db.query(
      'UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires_at=NULL WHERE id=$2',
      [hash, decoded.id]
    );
    console.log('[AUTH] ✅ Password reset via JWT token');
    res.json({ ok: true });
  } catch (e) {
    console.error('[AUTH] Reset error:', e.message);
    res.status(400).json({ error: 'Invalid or expired token' });
  }
};

app.post('/api/auth/reset', express.json(), resetPasswordHandler);
app.post('/api/auth/reset-password', express.json(), resetPasswordHandler);

app.get('/api/a11/history', verifyJWT, async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!db || !userId) return res.json([]);

    const summary = await db.query(
      `WITH message_conversations AS (
         SELECT COALESCE(conversation_id, 'default') AS conversation_id,
                COUNT(*)::int AS message_count,
                MAX(created_at) AS updated_at
         FROM messages
         WHERE user_id=$1
         GROUP BY COALESCE(conversation_id, 'default')
       ),
       resource_conversations AS (
         SELECT conversation_id,
                0::int AS message_count,
                MAX(updated_at) AS updated_at
         FROM conversation_resources
         WHERE user_id=$1
           AND (expires_at IS NULL OR expires_at > NOW())
         GROUP BY conversation_id
       ),
       merged AS (
         SELECT conversation_id,
                SUM(message_count)::int AS message_count,
                MAX(updated_at) AS updated_at
         FROM (
           SELECT * FROM message_conversations
           UNION ALL
           SELECT * FROM resource_conversations
         ) grouped
         GROUP BY conversation_id
       )
       SELECT conversation_id, message_count, updated_at
       FROM merged
       ORDER BY updated_at DESC, conversation_id ASC`,
      [userId]
    );

    const conversations = summary.rows.map((row) => ({
      id: String(row.conversation_id || 'default'),
      name: String(row.conversation_id || 'default') === 'default'
        ? 'Session par defaut'
        : String(row.conversation_id || 'default'),
      updated: row.updated_at || new Date().toISOString(),
      messageCount: Number(row.message_count || 0),
    }));

    return res.json(conversations);
  } catch (e) {
    console.error('[A11][History] List error:', e?.message);
    return res.status(500).json({ error: 'history_list_failed' });
  }
});

app.get('/api/a11/history/:id', verifyJWT, async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!db || !userId) {
      return res.json({ id: req.params.id, messages: [] });
    }

    const requestedId = String(req.params.id || '').trim();
    const legacyHistoryId = `user-${userId}`;
    const requestedConversationId = requestedId === legacyHistoryId
      ? ''
      : normalizeConversationId(requestedId);

    let result;
    if (requestedConversationId) {
      result = await db.query(
        'SELECT id, role, content, created_at FROM messages WHERE user_id=$1 AND COALESCE(conversation_id, $2)=$2 ORDER BY created_at ASC, id ASC LIMIT 200',
        [userId, requestedConversationId]
      );
    } else {
      result = await db.query(
        'SELECT id, role, content, created_at FROM messages WHERE user_id=$1 ORDER BY created_at ASC, id ASC LIMIT 200',
        [userId]
      );
    }

    return res.json({
      id: requestedConversationId || legacyHistoryId,
      conversationId: requestedConversationId || null,
      messages: result.rows.map((row) => ({
        id: `msg-${row.id}`,
        role: String(row.role || 'assistant'),
        content: String(row.content || ''),
        ts: row.created_at,
      })),
    });
  } catch (e) {
    console.error('[A11][History] Conversation error:', e?.message);
    return res.status(500).json({ error: 'history_conversation_failed' });
  }
});

app.delete('/api/a11/history', verifyJWT, async (req, res) => {
  const userId = String(req.user?.id || '').trim();
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'missing_user' });
  }

  let transactionStarted = false;
  try {
    let removedConversations = 0;
    let removedMessages = 0;
    let removedResources = 0;

    if (db) {
      const countResult = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM (
           SELECT COALESCE(conversation_id, 'default') AS conversation_id
           FROM messages
           WHERE user_id = $1
           UNION
           SELECT COALESCE(conversation_id, 'default') AS conversation_id
           FROM conversation_resources
           WHERE user_id = $1
         ) conversations`,
        [userId]
      );
      removedConversations = Number(countResult.rows[0]?.count || 0);

      await db.query('BEGIN');
      transactionStarted = true;

      const deletedMessages = await db.query('DELETE FROM messages WHERE user_id=$1', [userId]);
      const deletedResources = await db.query('DELETE FROM conversation_resources WHERE user_id=$1', [userId]);

      removedMessages = Number(deletedMessages.rowCount || 0);
      removedResources = Number(deletedResources.rowCount || 0);

      await db.query('COMMIT');
      transactionStarted = false;
    }

    const activityPurge = purgeConversationLogEntries({ userId });

    return res.json({
      ok: true,
      removedConversations,
      removedMessages,
      removedResources,
      removedActivityEntries: Number(activityPurge.removedEntries || 0),
    });
  } catch (e) {
    if (db && transactionStarted) {
      try { await db.query('ROLLBACK'); } catch {}
    }
    console.error('[A11][History] Clear error:', e?.message);
    return res.status(500).json({
      ok: false,
      error: 'history_clear_failed',
      message: String(e?.message || e),
    });
  }
});

app.delete('/api/a11/history/:id', verifyJWT, async (req, res) => {
  const userId = String(req.user?.id || '').trim();
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'missing_user' });
  }

  const requestedId = String(req.params.id || '').trim();
  if (!requestedId) {
    return res.status(400).json({ ok: false, error: 'missing_conversation_id' });
  }

  const legacyHistoryId = `user-${userId}`;
  const targetConversationId = requestedId === legacyHistoryId
    ? 'default'
    : normalizeConversationId(requestedId);

  let transactionStarted = false;
  try {
    let removedMessages = 0;
    let removedResources = 0;

    if (db) {
      await db.query('BEGIN');
      transactionStarted = true;

      const deletedMessages = await db.query(
        `DELETE FROM messages
         WHERE user_id = $1
           AND COALESCE(conversation_id, 'default') = $2`,
        [userId, targetConversationId]
      );
      const deletedResources = await db.query(
        `DELETE FROM conversation_resources
         WHERE user_id = $1
           AND COALESCE(conversation_id, 'default') = $2`,
        [userId, targetConversationId]
      );

      removedMessages = Number(deletedMessages.rowCount || 0);
      removedResources = Number(deletedResources.rowCount || 0);

      await db.query('COMMIT');
      transactionStarted = false;
    }

    const activityPurge = purgeConversationLogEntries({
      userId,
      conversationId: targetConversationId,
    });
    const removed = removedMessages > 0
      || removedResources > 0
      || Number(activityPurge.removedEntries || 0) > 0;

    return res.json({
      ok: true,
      removed,
      id: targetConversationId,
      removedMessages,
      removedResources,
      removedActivityEntries: Number(activityPurge.removedEntries || 0),
    });
  } catch (e) {
    if (db && transactionStarted) {
      try { await db.query('ROLLBACK'); } catch {}
    }
    console.error('[A11][History] Delete error:', e?.message);
    return res.status(500).json({
      ok: false,
      error: 'history_delete_failed',
      message: String(e?.message || e),
    });
  }
});

app.get('/api/a11/history/:id/resources', verifyJWT, async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });

    const requestedId = String(req.params.id || '').trim();
    const legacyHistoryId = `user-${userId}`;
    const queryConversationId = String(req.query.conversationId || '').trim();
    const requestedConversationId = requestedId && requestedId !== legacyHistoryId
      ? normalizeConversationId(requestedId)
      : (queryConversationId ? normalizeConversationId(queryConversationId) : '');
    const requestedKind = String(req.query.kind || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const resources = await listConversationResources(userId, {
      conversationId: requestedConversationId,
      resourceKind: requestedKind,
      limit,
    });

    return res.json({
      ok: true,
      id: requestedId || legacyHistoryId,
      conversationId: requestedConversationId || null,
      resources,
      count: resources.length,
    });
  } catch (e) {
    console.error('[A11][History] Resource list error:', e?.message);
    return res.status(500).json({ ok: false, error: 'history_resource_list_failed' });
  }
});

app.get('/api/a11/history/:id/activity', verifyJWT, async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });

    const requestedId = String(req.params.id || '').trim();
    const legacyHistoryId = `user-${userId}`;
    const queryConversationId = String(req.query.conversationId || '').trim();
    const requestedConversationId = requestedId && requestedId !== legacyHistoryId
      ? normalizeConversationId(requestedId)
      : (queryConversationId ? normalizeConversationId(queryConversationId) : '');
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 12)));

    if (!requestedConversationId) {
      return res.json({
        ok: true,
        id: requestedId || legacyHistoryId,
        conversationId: null,
        entries: [],
        count: 0,
      });
    }

    const rawEntries = readConversationLogEntries({
      userId,
      conversationId: requestedConversationId,
      limit,
    });
    const entries = rawEntries.map((entry, index) => buildConversationActivityEntry(entry, index));

    return res.json({
      ok: true,
      id: requestedId || legacyHistoryId,
      conversationId: requestedConversationId,
      entries,
      count: entries.length,
    });
  } catch (e) {
    console.error('[A11][History] Activity list error:', e?.message);
    return res.status(500).json({ ok: false, error: 'history_activity_list_failed' });
  }
});

// ✅ AUTH MIDDLEWARE - appliqué SEULEMENT sur /api/ai pour protéger chat
// /api/auth/login reste public!
app.use('/api/ai', verifyJWT);
app.use('/api/agent', verifyJWT);
app.use('/api/files', verifyJWT);
app.use('/api/artifacts', verifyJWT);
app.use('/api/resources', verifyJWT);
app.use('/api/mail', verifyJWT);

app.post('/api/files/upload', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });

    if (!isR2Configured()) {
      return res.status(503).json({ ok: false, error: 'r2_not_configured' });
    }

    const {
      filename,
      contentBase64,
      contentType,
      conversationId,
      convId,
      sessionId,
      emailTo,
      emailSubject,
      emailMessage,
      attachToEmail,
      expiresAt,
      ttlSeconds,
    } = req.body || {};
    const normalizedConversationId = normalizeConversationId(conversationId || convId || sessionId);
    const resolvedExpiresAt = normalizeOptionalTimestamp(expiresAt)
      || buildTemporaryFileExpiryDate(Number(ttlSeconds || 0) > 0 ? Number(ttlSeconds) * 1000 : TEMP_SHARED_FILE_TTL_MS);
    const ingestion = await ingestUploadedFile({
      userId,
      filename,
      contentType,
      contentBase64,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
      origin: 'upload',
      conversationId: normalizedConversationId,
      resourceKind: 'file',
      resourceMetadata: {
        source: 'api.files.upload',
      },
      linkConversationResource,
      analyzeResourceContent: analyzeUploadedResource,
      uploadBufferToR2,
      saveFileRecord,
      saveUserFileMemory,
      sanitizeFileName,
      expiresAt: resolvedExpiresAt,
    });

    let mail = null;
    if (emailTo) {
      mail = await sendFileEmail({
        to: emailTo,
        subject: emailSubject || 'A11 — fichier généré',
        message: emailMessage || 'Ton fichier est prêt.',
        fileUrl: ingestion.file.url,
        attachment: attachToEmail ? { filename: ingestion.file.filename, buffer: ingestion.buffer } : null,
      });
    }

    appendConversationLog({
      type: 'file_uploaded',
      userId,
      conversationId: normalizedConversationId,
      file: {
        filename: ingestion.file.filename,
        storageKey: ingestion.file.storageKey,
        url: ingestion.file.url,
        contentType: ingestion.file.contentType,
        sizeBytes: ingestion.file.sizeBytes,
      },
      analysis: ingestion.analysis || ingestion.conversationResource?.metadata?.analysis || null,
      mail,
    });

    return res.json({
      ok: true,
      conversationId: normalizedConversationId,
      file: {
        ...ingestion.file,
        downloadUrl: ingestion.file.url,
        expiresAt: resolvedExpiresAt.toISOString(),
      },
      record: ingestion.record,
      conversationResource: ingestion.conversationResource
        ? {
            ...ingestion.conversationResource,
            downloadUrl: ingestion.conversationResource.url || ingestion.file.url,
            expiresAt: ingestion.conversationResource.expiresAt || resolvedExpiresAt.toISOString(),
          }
        : null,
      mail,
    });
  } catch (e) {
    if (e?.code === 'missing_content_base64' || e?.code === 'invalid_base64_content') {
      return res.status(400).json({ ok: false, error: e.code });
    }
    if (e?.code === 'file_too_large') {
      return res.status(413).json({ ok: false, error: e.code, maxBytes: e.maxBytes || FILE_UPLOAD_MAX_BYTES });
    }
    console.error('[FILES] upload failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'upload_failed', message: String(e?.message) });
  }
});

app.get('/api/resources/my', async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });
    await cleanupExpiredSharedFiles({ userId, limit: 200 });

    const requestedConversationId = String(req.query.conversationId || '').trim();
    const requestedKind = String(req.query.kind || '').trim();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const resources = await listConversationResources(userId, {
      conversationId: requestedConversationId,
      resourceKind: requestedKind,
      limit,
    });

    return res.json({
      ok: true,
      conversationId: requestedConversationId ? normalizeConversationId(requestedConversationId) : null,
      resources,
      count: resources.length,
    });
  } catch (e) {
    console.error('[RESOURCES] list failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'resource_list_failed', message: String(e?.message) });
  }
});

app.get('/api/resources/:id/download', async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });
    await cleanupExpiredSharedFiles({ userId, limit: 200 });

    const resourceId = Number(req.params?.id || 0);
    if (!Number.isFinite(resourceId) || resourceId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_resource_id' });
    }

    const resource = await getConversationResourceById(userId, resourceId);
    if (!resource) {
      return res.status(404).json({ ok: false, error: 'resource_not_found' });
    }
    if (isResourceExpired(resource)) {
      return res.status(410).json({ ok: false, error: 'resource_expired' });
    }
    if (!resource.storageKey || !isR2Configured()) {
      return res.status(409).json({ ok: false, error: 'resource_download_not_available' });
    }

    const downloaded = await downloadBufferFromR2(resource.storageKey);
    const downloadName = sanitizeFileName(resource.filename || `resource-${resourceId}.bin`);
    const encodedDownloadName = encodeURIComponent(downloadName);

    res.setHeader('Content-Type', downloaded.contentType || resource.contentType || 'application/octet-stream');
    if (downloaded.contentLength || resource.sizeBytes) {
      res.setHeader('Content-Length', String(downloaded.contentLength || resource.sizeBytes || 0));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"; filename*=UTF-8''${encodedDownloadName}`);
    res.setHeader('Cache-Control', 'private, no-store');

    appendConversationLog({
      type: 'resource_downloaded',
      userId,
      conversationId: resource.conversationId || 'default',
      resource: {
        id: resource.id,
        filename: resource.filename,
        resourceKind: resource.resourceKind,
        storageKey: resource.storageKey,
        contentType: resource.contentType,
        sizeBytes: resource.sizeBytes,
      },
    });

    return res.status(200).send(downloaded.buffer);
  } catch (e) {
    console.error('[RESOURCES] download failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'resource_download_failed', message: String(e?.message) });
  }
});

app.get('/api/resources/latest', async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });
    await cleanupExpiredSharedFiles({ userId, limit: 200 });

    const latestResource = await getLatestConversationResource(userId, {
      conversationId: req.query.conversationId,
      resourceKind: req.query.kind,
    });

    if (!latestResource) {
      return res.status(404).json({ ok: false, error: 'latest_resource_not_found' });
    }

    return res.json({
      ok: true,
      resource: latestResource,
    });
  } catch (e) {
    console.error('[RESOURCES] latest failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'latest_resource_failed', message: String(e?.message) });
  }
});

app.post('/api/resources/email', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });
    if (!emailService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'mail_provider_not_configured' });
    }

    const result = await sendConversationResourceEmailNow({
      userId,
      resourceId: req.body?.resourceId,
      to: req.body?.to || req.body?.emailTo || req.body?.recipients || '',
      subject: req.body?.subject,
      message: req.body?.message,
      attachToEmail: req.body?.attachToEmail === true || req.body?.attachToEmail === 'true',
    });

    if (!result?.ok) {
      if (result.error === 'resource_not_found') return res.status(404).json(result);
      if (result.error === 'missing_to') return res.status(400).json(result);
      if (result.error === 'mail_provider_not_configured') return res.status(503).json(result);
      return res.status(502).json(result);
    }

    return res.json(result);
  } catch (e) {
    console.error('[RESOURCES] email failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'resource_email_failed', message: String(e?.message) });
  }
});

app.post('/api/resources/latest/email', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });
    if (!emailService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'mail_provider_not_configured' });
    }

    const result = await sendLatestConversationResourceEmailNow({
      userId,
      conversationId: req.body?.conversationId || req.body?.convId || req.body?.sessionId || req.query?.conversationId,
      resourceKind: req.body?.kind || req.body?.resourceKind || req.query?.kind,
      to: req.body?.to || req.body?.emailTo || req.body?.recipients || '',
      subject: req.body?.subject,
      message: req.body?.message,
      attachToEmail: req.body?.attachToEmail === true || req.body?.attachToEmail === 'true',
    });

    if (!result?.ok) {
      if (result.error === 'latest_resource_not_found') return res.status(404).json(result);
      if (result.error === 'missing_to') return res.status(400).json(result);
      if (result.error === 'mail_provider_not_configured') return res.status(503).json(result);
      return res.status(502).json(result);
    }

    return res.json(result);
  } catch (e) {
    console.error('[RESOURCES] latest email failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'latest_resource_email_failed', message: String(e?.message) });
  }
});

app.post('/api/mail/send', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!emailService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'mail_provider_not_configured' });
    }

    const attachments = normalizeInlineAttachments(req.body?.attachments);
    const result = await sendPlainEmailNow({
      userId,
      to: req.body?.to || req.body?.emailTo || req.body?.recipients || '',
      subject: req.body?.subject || req.body?.emailSubject || 'A11',
      text: String(req.body?.message || req.body?.text || req.body?.body || '').trim() || (!req.body?.html ? 'Email envoye depuis A11.' : undefined),
      html: typeof req.body?.html === 'string' ? req.body.html : undefined,
      attachments,
      conversationId: req.body?.conversationId || req.body?.convId || req.body?.sessionId,
      tags: [{ name: 'type', value: 'agent_mail' }],
      logType: 'mail_sent',
    });

    if (!result?.ok) {
      if (result.error === 'missing_to') return res.status(400).json(result);
      if (result.error === 'mail_provider_not_configured') return res.status(503).json(result);
      return res.status(502).json(result);
    }

    return res.json(result);
  } catch (e) {
    const code = e?.code || 'mail_send_failed';
    const status = code === 'missing_attachment_content' || code === 'invalid_attachment_base64' || code === 'empty_attachment'
      ? 400
      : 500;
    console.error('[MAIL] send failed:', e?.message);
    return res.status(status).json({ ok: false, error: code, index: e?.index ?? null, message: String(e?.message) });
  }
});

app.post('/api/mail/schedule', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!emailService.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'mail_provider_not_configured' });
    }

    const kind = normalizeScheduledMailKind(req.body?.kind);
    const recipients = normalizeEmailRecipients(req.body?.to || req.body?.emailTo || req.body?.recipients || '');
    if (!recipients.length) {
      return res.status(400).json({ ok: false, error: 'missing_to' });
    }

    const sendAt = computeScheduledSendAt({
      sendAt: req.body?.sendAt,
      delaySeconds: req.body?.delaySeconds ?? (Number.isFinite(Number(req.body?.delayMinutes)) ? Number(req.body.delayMinutes) * 60 : req.body?.delay),
    });

    const job = {
      id: buildScheduledMailJobId(),
      kind,
      status: 'scheduled',
      userId,
      createdAt: new Date().toISOString(),
      sendAt,
      conversationId: normalizeConversationId(req.body?.conversationId || req.body?.convId || req.body?.sessionId),
      to: recipients,
      subject: String(req.body?.subject || req.body?.emailSubject || 'A11').trim() || 'A11',
      message: String(req.body?.message || req.body?.text || req.body?.body || '').trim(),
      html: typeof req.body?.html === 'string' ? req.body.html : '',
      attachToEmail: req.body?.attachToEmail === true || req.body?.attachToEmail === 'true',
      attachments: [],
      resourceId: null,
      resourceKind: String(req.body?.kindFilter || req.body?.resourceKind || req.body?.resource_type || '').trim() || '',
    };

    if (kind === 'email') {
      job.attachments = normalizeInlineAttachments(req.body?.attachments);
    } else if (kind === 'resource_email') {
      job.resourceId = Number(req.body?.resourceId || 0);
      if (!Number.isFinite(job.resourceId) || job.resourceId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_resource_id' });
      }
      const resource = await getConversationResourceById(userId, job.resourceId);
      if (!resource) {
        return res.status(404).json({ ok: false, error: 'resource_not_found' });
      }
    } else if (kind === 'latest_resource_email') {
      const latestResource = await getLatestConversationResource(userId, {
        conversationId: job.conversationId,
        resourceKind: job.resourceKind || undefined,
      });
      if (!latestResource) {
        return res.status(404).json({ ok: false, error: 'latest_resource_not_found' });
      }
    }

    const jobs = readScheduledMailJobs();
    jobs.push(job);
    writeScheduledMailJobs(jobs);
    scheduleMailTimer(job);

    appendConversationLog({
      type: 'mail_scheduled',
      userId,
      conversationId: job.conversationId,
      mail: summarizeScheduledMailJob(job),
    });

    return res.json({
      ok: true,
      job: summarizeScheduledMailJob(job),
    });
  } catch (e) {
    const code = e?.message === 'invalid_sendAt' ? 'invalid_sendAt' : (e?.code || 'mail_schedule_failed');
    const status = code === 'invalid_sendAt' || code === 'missing_attachment_content' || code === 'invalid_attachment_base64' || code === 'empty_attachment'
      ? 400
      : 500;
    console.error('[MAIL] schedule failed:', e?.message);
    return res.status(status).json({ ok: false, error: code, index: e?.index ?? null, message: String(e?.message) });
  }
});

app.get('/api/mail/scheduled', async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });

    const requestedStatus = String(req.query.status || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const jobs = readScheduledMailJobs()
      .filter((job) => String(job?.userId || '') === userId)
      .filter((job) => !requestedStatus || String(job?.status || '').toLowerCase() === requestedStatus)
      .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())
      .slice(0, limit)
      .map((job) => summarizeScheduledMailJob(job));

    return res.json({
      ok: true,
      count: jobs.length,
      jobs,
    });
  } catch (e) {
    console.error('[MAIL] scheduled list failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'scheduled_mail_list_failed', message: String(e?.message) });
  }
});

app.post('/api/mail/scheduled/:id/cancel', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });

    const jobId = String(req.params?.id || '').trim();
    const jobs = readScheduledMailJobs();
    const index = jobs.findIndex((job) => job?.id === jobId && String(job?.userId || '') === userId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: 'scheduled_mail_not_found' });
    }

    if (jobs[index].status !== 'scheduled') {
      return res.status(409).json({ ok: false, error: 'scheduled_mail_not_cancellable', job: summarizeScheduledMailJob(jobs[index]) });
    }

    jobs[index].status = 'cancelled';
    jobs[index].cancelledAt = new Date().toISOString();
    writeScheduledMailJobs(jobs);

    const timer = scheduledMailTimers.get(jobId);
    if (timer) clearTimeout(timer);
    scheduledMailTimers.delete(jobId);

    const job = summarizeScheduledMailJob(jobs[index]);
    appendConversationLog({
      type: 'mail_schedule_cancelled',
      userId,
      conversationId: jobs[index].conversationId || 'default',
      mail: job,
    });

    return res.json({
      ok: true,
      job,
    });
  } catch (e) {
    console.error('[MAIL] scheduled cancel failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'scheduled_mail_cancel_failed', message: String(e?.message) });
  }
});

app.get('/api/files/my', async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });
    await cleanupExpiredSharedFiles({ userId, limit: 200 });

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const result = await db.query(
      `SELECT id, user_id, filename, storage_key, url, content_type, size_bytes, expires_at, created_at
       FROM files
       WHERE user_id=$1
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [userId, limit]
    );

    return res.json({ ok: true, files: result.rows, count: result.rows.length });
  } catch (e) {
    console.error('[FILES] list failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'list_failed', message: String(e?.message) });
  }
});

app.get('/api/memory', verifyJWT, async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });

    const [summary, facts, tasks, files] = await Promise.all([
      getLogicalUserMemory(userId),
      getUserFacts(userId, FACT_MEMORY_LIMIT),
      getUserTasks(userId, TASK_MEMORY_LIMIT),
      getUserFilesMemory(userId, FILE_MEMORY_LIMIT),
    ]);

    return res.json({
      ok: true,
      userId,
      memory: {
        summary,
        facts,
        tasks,
        files,
      },
      limits: {
        facts: FACT_MEMORY_LIMIT,
        tasks: TASK_MEMORY_LIMIT,
        files: FILE_MEMORY_LIMIT,
      }
    });
  } catch (e) {
    console.error('[MEMORY] read failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'memory_read_failed', message: String(e?.message) });
  }
});

app.post('/api/memory/purge-now', verifyJWT, express.json(), async (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ ok: false, error: 'admin_required' });
    }

    const targetUserId = String(req.body?.userId || req.query.userId || req.user?.id || '').trim();
    const dryRunRaw = req.body?.dryRun ?? req.query?.dryRun;
    const dryRun = dryRunRaw === true || dryRunRaw === 'true' || dryRunRaw === '1' || dryRunRaw === 1;
    if (!targetUserId) {
      return res.status(400).json({ ok: false, error: 'missing_user_id' });
    }
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });

    const before = await getStructuredMemoryCounts(targetUserId);
    let after = before;
    let removed = { facts: 0, tasks: 0, files: 0 };
    let wouldRemove = null;

    if (dryRun) {
      wouldRemove = await getStructuredMemoryPurgeCandidates(targetUserId);
    } else {
      await pruneStructuredMemory(targetUserId);
      after = await getStructuredMemoryCounts(targetUserId);
      removed = {
        facts: Math.max(0, before.facts - after.facts),
        tasks: Math.max(0, before.tasks - after.tasks),
        files: Math.max(0, before.files - after.files),
      };
    }

    return res.json({
      ok: true,
      userId: targetUserId,
      dryRun,
      purgeTriggeredAt: new Date().toISOString(),
      before,
      after,
      removed,
      wouldRemove,
    });
  } catch (e) {
    console.error('[MEMORY] purge-now failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'memory_purge_failed', message: String(e?.message) });
  }
});

// ✅ PROTECTED CHAT ROUTE — /api/ai/chat (auth required via middleware)
// Centralized proxy with user context.
// If LOCAL_LLM_URL is set and provider is not explicit, default to provider=local
// so the unified proxy can target llama.cpp /completion.
app.post('/api/ai/chat', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    // req.user is available from Nezlephant middleware
    const user = req.user?.id || 'anonymous';
    console.log(`[A11][AuthChat] User ${user} calling /api/ai/chat`);

    // Forward to the canonical proxy with optional user context.
    const body = {
      ...req.body,
      _user: user  // Pass user context to LLM router for potential routing
    };

    if (!body.provider && (process.env.LOCAL_LLM_URL?.trim() || process.env.LLAMA_BASE?.trim() || getQflushChatFlow())) {
      body.provider = 'local';
    }

    req.body = body;
    return proxyChatToOpenAI(req, res);
  } catch (err) {
    console.error('[A11][AuthChat] Proxy error:', err?.message);
    res.status(502).json({
      ok: false,
      error: 'upstream_unreachable',
      message: String(err?.message)
    });
  }
});

// Serve system prompt for legacy frontend (public, no auth)
app.get('/api/system-prompt', (_req, res) => {
  try {
    const promptPath = path.join(__dirname, 'system_prompt.txt');
    if (!fs.existsSync(promptPath)) {
      return res.status(404).json({ ok: false, error: 'system_prompt_not_found' });
    }
    const text = fs.readFileSync(promptPath, 'utf8');
    return res.json({ ok: true, systemPrompt: text });
  } catch (err) {
    console.error('[A11] Failed to read system_prompt:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'read_error' });
  }
});



// Proxy /api/llm/stats to the configured LLM router (Cerbère) or DEFAULT_UPSTREAM
let __stats_cache = null;
let __stats_cache_ts = 0;
const STATS_CACHE_MS = Number(process.env.STATS_CACHE_MS) || 5000; // cache stats for 5s by default
let __last_probe_log = 0;

app.get('/api/llm/stats', async (req, res) => {
  try {
    const now = Date.now();
    // serve cached value if fresh
    if (__stats_cache && (now - __stats_cache_ts) < STATS_CACHE_MS) {
      // minimal log to indicate cached hit
      if (now - __last_probe_log > 60000) {
        console.log('[A11] /api/llm/stats - serving cached result');
        __last_probe_log = now;
      }
      return res.json(__stats_cache);
    }

    const upstreamHost = process.env.LLM_ROUTER_URL?.trim() || DEFAULT_UPSTREAM || 'http://a11llm.railway.internal:8080';
    const probeUrl = String(upstreamHost).replace(/\/$/, '') + '/api/stats';
    console.log('[A11] Proxying /api/llm/stats ->', probeUrl);

    const r = await fetch(probeUrl, { method: 'GET' });
    if (!r.ok) {
      const txt = await r.text().catch(() => null);
      const payload = { ok: false, error: 'upstream_error', detail: txt };
      __stats_cache = payload; __stats_cache_ts = Date.now();
      return res.status(r.status).json(payload);
    }
    const json = await r.json().catch(() => null) || { ok: true };

    __stats_cache = json; __stats_cache_ts = Date.now();

    // --- MEMO AUTO: snapshot LLM stats ---
    try {
      saveMemo('llm_stats', {
        ts: Date.now(),
        stats: json
      });
    } catch (e) {
      console.warn('[A11][memo] llm_stats save failed:', e?.message);
    }
    // -------------------------------------

    return res.json(json);
  } catch (e) {
    console.error('[A11] /api/llm/stats proxy error:', e?.message);
    return res.status(502).json({ ok: false, error: 'upstream_unreachable', message: String(e?.message) });
  }
});

// Ajout helmet et cookieParser AVANT les routes
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());

// Serve frontend static files from a configurable embedded build directory.
const webPublic = (() => {
  const configured = String(process.env.A11_WEB_DIST_DIR || '').trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(__dirname, configured);
  }
  return path.resolve(__dirname, '..', 'web', 'dist');
})();
try {
  const serveStatic = process.env.SERVE_STATIC?.toLowerCase() === 'true' || process.env.NODE_ENV === 'production';
  if (serveStatic) {
    if (fs.existsSync(webPublic)) {
      app.use(express.static(webPublic, { maxAge: '1d' }));
      console.log('[A11] Serving frontend static from', webPublic);
    } else {
      console.log('[A11] Frontend public folder not found at', webPublic);
    }
  } else {
    console.log('[A11] Skipping static middleware for web public (DEV mode or SERVE_STATIC!=true)');
  }
} catch (e) {
  console.warn('[A11] Could not initialize static middleware for web public:', e?.message);
}

// Serve legacy-prefixed URLs from the canonical web public folder as well
try {
  const serveLegacy = process.env.SERVE_STATIC?.toLowerCase() === 'true' || process.env.NODE_ENV === 'production';
  if (serveLegacy) {
    if (fs.existsSync(webPublic)) {
      app.use('/legacy', express.static(webPublic, { maxAge: '1d' }));
      console.log('[A11] Also serving web public under /legacy ->', webPublic);
    }
  } else {
    console.log('[A11] Skipping /legacy static middleware (DEV mode)');
  }
} catch (e) {
  console.warn('[A11] Could not initialize /legacy static middleware for web public:', e?.message);
}

// Ajout des routes /healthz et /
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/status', (_req, res) => {
  try {
    return res.json(getPublicRuntimeStatus({
      config: buildRuntimeConfig(process.env),
      hasDb: Boolean(db),
      isR2Configured: isR2Configured(),
      hasResend: emailService.isConfigured(),
      hasQflush: Boolean(QFLUSH_AVAILABLE),
    }));
  } catch (error_) {
    return res.status(500).json({
      ok: false,
      service: 'a11-api',
      error: String(error_?.message || error_),
      timestamp: new Date().toISOString(),
    });
  }
});

app.post('/api/artifacts/create', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });

    if (!isR2Configured()) {
      return res.status(503).json({ ok: false, error: 'r2_not_configured' });
    }

    const {
      filename,
      contentBase64,
      contentType,
      kind,
      conversationId,
      description,
      emailTo,
      emailSubject,
      emailMessage,
      attachToEmail,
    } = req.body || {};

    const result = await createArtifact({
      userId,
      filename,
      contentBase64,
      contentType,
      kind,
      conversationId,
      description,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
      emailTo,
      emailSubject,
      emailMessage,
      attachToEmail,
      sanitizeFileName,
      ingestUploadedFile: (payload) => ingestUploadedFile({
        ...payload,
        linkConversationResource,
        analyzeResourceContent: analyzeUploadedResource,
        uploadBufferToR2,
        saveFileRecord,
        saveUserFileMemory,
        sanitizeFileName,
      }),
      sendFileEmail,
      appendConversationLog,
      normalizeConversationId,
    });

    return res.json({
      ok: true,
      artifact: result.artifact,
      record: result.record,
      mail: result.mail,
      conversationResource: result.conversationResource || null,
    });
  } catch (e) {
    if (e?.code === 'missing_content_base64' || e?.code === 'invalid_base64_content') {
      return res.status(400).json({ ok: false, error: e.code });
    }
    if (e?.code === 'file_too_large') {
      return res.status(413).json({ ok: false, error: e.code, maxBytes: e.maxBytes || FILE_UPLOAD_MAX_BYTES });
    }
    console.error('[ARTIFACTS] create failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'artifact_create_failed', message: String(e?.message) });
  }
});

app.get('/api/artifacts/my', async (req, res) => {
  try {
    const userId = String(req.user?.id || '').trim();
    if (!userId) return res.status(401).json({ ok: false, error: 'missing_user' });
    if (!db) return res.status(503).json({ ok: false, error: 'database_unavailable' });

    const requestedKind = String(req.query.kind || '').trim();
    const normalizedKind = requestedKind ? normalizeArtifactKind(requestedKind) : '';
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const originPrefix = normalizedKind ? buildArtifactOrigin(normalizedKind) : 'artifact:%';

    const result = await db.query(
      `SELECT filename, storage_key, url, content_type, size_bytes, origin, created_at, updated_at
       FROM user_files
       WHERE user_id=$1
         AND origin LIKE $2
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT $3`,
      [userId, originPrefix, limit]
    );

    const artifacts = result.rows.map((row) => ({
      kind: String(row.origin || '').startsWith('artifact:') ? String(row.origin).slice('artifact:'.length) : 'generated',
      filename: row.filename,
      storageKey: row.storage_key,
      url: row.url,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      origin: row.origin,
    }));

    return res.json({ ok: true, artifacts, count: artifacts.length });
  } catch (e) {
    console.error('[ARTIFACTS] list failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'artifact_list_failed', message: String(e?.message) });
  }
});
app.get('/', (_req, res) => res.status(200).json({ ok: true, service: 'a11-api' }));

function getOpenAICompletionsUrl() {
  const base = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function extractLowercaseOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.origin.toLowerCase();
  } catch {
    return '';
  }
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host || '').trim();
  const proto = forwardedProto || req.protocol || 'http';
  if (!host) return '';
  return `${proto}://${host}`.toLowerCase();
}

function getAuthTokenFromRequest(req) {
  const headerToken = String(req.headers['x-nez-token'] || '').trim();
  const bearerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return headerToken || bearerToken;
}

function isRecursiveOpenAIUpstream(req, upstreamUrl) {
  const normalizedUpstream = String(upstreamUrl || '').trim();
  if (!normalizedUpstream) return false;

  const upstreamOrigin = extractLowercaseOrigin(normalizedUpstream);
  if (!upstreamOrigin) return false;

  const candidateOrigins = new Set();
  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin) candidateOrigins.add(requestOrigin);

  const publicApiUrl = String(process.env.PUBLIC_API_URL || process.env.API_URL || '').trim();
  const publicApiOrigin = extractLowercaseOrigin(publicApiUrl);
  if (publicApiOrigin) candidateOrigins.add(publicApiOrigin);

  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railwayPublicDomain) {
    candidateOrigins.add(`https://${railwayPublicDomain}`.toLowerCase());
    candidateOrigins.add(`http://${railwayPublicDomain}`.toLowerCase());
  }

  try {
    const parsedUpstream = new URL(normalizedUpstream);
    return candidateOrigins.has(upstreamOrigin) && parsedUpstream.pathname === '/v1/chat/completions';
  } catch {
    return false;
  }
}

function getLocalCompletionsUrl() {
  const explicitBase = String(process.env.LLAMA_BASE || process.env.LLM_URL || '').trim();
  const routerBase = String(process.env.LLM_ROUTER_URL || '').trim();
  const inferredLocalBase = (String(process.env.BACKEND || '').trim().toLowerCase() === 'local' || String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production')
    ? `http://127.0.0.1:${String(process.env.LLAMA_PORT || process.env.LOCAL_LLM_PORT || '8080').trim() || '8080'}`
    : '';
  const base = explicitBase || routerBase || inferredLocalBase;
  if (!base) return null;
  const normalized = base.replace(/\/$/, '');
  return normalized.endsWith('/v1') ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

function getLocalLlamaCompletionUrl() {
  const base = String(process.env.LOCAL_LLM_URL || '').trim();
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/completion`;
}

function shouldFallbackToLocalOnOpenAIError(err) {
  const status = Number(err?.response?.status || 0);
  const code = String(err?.response?.data?.error?.code || '').trim().toLowerCase();
  if (status === 429 && code === 'insufficient_quota') return true;
  if (status === 401 && code === 'invalid_issuer') return true;
  return false;
}

function normalizeChatRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'system' || normalized === 'assistant' || normalized === 'user') return normalized;
  return null;
}

function normalizeChatTimestamp(value) {
  if (!value) return null;
  const candidate = value instanceof Date ? value : new Date(value);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function formatChatTemporalValue(value, options = {}) {
  const timestamp = normalizeChatTimestamp(value);
  if (!timestamp) return '';
  try {
    return new Intl.DateTimeFormat(CHAT_TIME_LOCALE, {
      timeZone: CHAT_TIMEZONE,
      ...options,
    }).format(timestamp);
  } catch {
    return timestamp.toISOString();
  }
}

function truncateTemporalPreview(value, maxLength = 90) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function buildTemporalContextBlock(messages = []) {
  const now = new Date();
  const lines = [
    `Fuseau horaire de reference: ${CHAT_TIMEZONE}.`,
    `Maintenant: ${formatChatTemporalValue(now, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}.`,
    `Date de reference: ${formatChatTemporalValue(now, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}.`,
    "Quand l'utilisateur dit aujourd'hui, hier, demain, ce matin, ce soir ou maintenant, interprete-le par rapport a ce repere.",
  ];

  const recentTimestampedMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && typeof message.content === 'string' && message.content.trim())
    .map((message) => ({
      role: normalizeChatRole(message?.role) || 'assistant',
      timestamp: normalizeChatTimestamp(message?.ts),
      preview: truncateTemporalPreview(message?.content, 96),
    }))
    .filter((entry) => entry.timestamp && entry.role !== 'system')
    .slice(-6);

  if (recentTimestampedMessages.length) {
    lines.push('', 'Horodatage recent du chat:');
    for (const entry of recentTimestampedMessages) {
      lines.push(
        `- ${entry.role} @ ${formatChatTemporalValue(entry.timestamp, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}: ${entry.preview}`
      );
    }
  }

  return lines.join('\n');
}

function buildTemporalSystemMessage(messages = []) {
  const content = buildTemporalContextBlock(messages);
  if (!content) return null;
  return {
    role: 'system',
    content,
  };
}

function sanitizePromptMessages(messages) {
  if (!Array.isArray(messages)) return [];

  const sanitized = [];
  for (const message of messages) {
    const role = normalizeChatRole(message?.role);
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (!role || !content) continue;

    const previous = sanitized.at(-1);
    // Drop accidental adjacent duplicates that can create echo effects.
    if (previous?.role === role && previous?.content === content) continue;

    sanitized.push({ role, content });
  }

  // Keep a bounded history to reduce prompt drift and self-referential loops.
  return sanitized.slice(-24);
}

function buildPromptFromMessages(messages) {
  const sanitized = sanitizePromptMessages(messages);
  if (sanitized.length === 0) return '';

  const lines = sanitized.map((message) => `${message.role}: ${message.content}`);

  // Force one assistant turn completion and avoid continuing previous assistant text.
  const lastRole = sanitized.at(-1)?.role;
  if (lastRole !== 'assistant') {
    lines.push('assistant:');
  }

  return lines.join('\n');
}

function extractLocalCompletionContent(payload) {
  const normalize = (value) => normalizeAssistantOutput(value);
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.content === 'string') return normalize(payload.content);
  if (typeof payload.response === 'string') return normalize(payload.response);
  if (Array.isArray(payload.choices) && payload.choices[0]?.text) return normalize(String(payload.choices[0].text));
  return '';
}

function normalizeAssistantOutput(value) {
  let text = String(value || '').trim();
  if (!text) return '';

  text = text
    .replace(/^(?:voici|voila)\s+la\s+reponse\s+finale\s*:\s*/i, '')
    .replace(/^la\s+reponse\s+finale\s+est\s*:\s*/i, '')
    .replace(/^reponse\s+finale(?:\s+utilisateur)?\s*:\s*/i, '')
    .trim();

  if (/^["“][\s\S]*["”]$/.test(text)) {
    text = text.slice(1, -1).trim();
  }

  // Remove leading role prefixes repeatedly (assistant:, a-11:, bot:, etc.).
  for (let index = 0; index < 4; index += 1) {
    const next = text.replace(/^(assistant|a-11|bot)\s*:\s*/i, '').trim();
    if (next === text) break;
    text = next;
  }

  // Keep only the first assistant segment and drop leaked synthetic turns.
  const lower = text.toLowerCase();
  const separators = ['\nuser:', '\nassistant:', '\nsystem:', '\ntoi', '\na-11'];
  let cutAt = -1;
  for (const separator of separators) {
    const position = lower.indexOf(separator);
    if (position > 0 && (cutAt === -1 || position < cutAt)) {
      cutAt = position;
    }
  }
  if (cutAt > 0) {
    text = text.slice(0, cutAt).trim();
  }

  const dedupedLines = [];
  let previousLineKey = '';
  for (const line of text.split(/\r?\n/)) {
    const normalizedLine = line.trim();
    const lineKey = normalizedLine.toLowerCase().replace(/\s+/g, ' ');
    if (lineKey && lineKey === previousLineKey) continue;
    dedupedLines.push(line);
    previousLineKey = lineKey;
  }
  text = dedupedLines.join('\n').trim();

  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length > 1) {
    const dedupedBlocks = [];
    let previousBlockKey = '';
    for (const block of blocks) {
      const blockKey = block.toLowerCase().replace(/\s+/g, ' ');
      if (blockKey && blockKey === previousBlockKey) continue;
      dedupedBlocks.push(block);
      previousBlockKey = blockKey;
    }
    text = dedupedBlocks.join('\n\n').trim();
  }

  return text;
}

function shouldKeepRecentUserActionContext(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  return /\b(le|la|les|lui|leur|ca|ça|cela|celui|celle|celui-ci|celle-ci|ce fichier|ce pdf|ce document|cette image|dernier|derniere|dernière)\b/.test(text);
}

function buildUserSafeAgentMessages(body) {
  const latestUserMessage = getLatestUserMessage(body || {});
  const normalizedLatest = String(latestUserMessage || '').trim();
  const sourceMessages = Array.isArray(body?.messages) ? body.messages : [];
  const visibleMessages = sourceMessages
    .filter((entry) => entry && entry.role !== 'system' && typeof entry.content === 'string' && entry.content.trim())
    .map((entry) => ({
      role: entry.role === 'assistant' ? 'assistant' : 'user',
      content: String(entry.content || '').trim(),
    }));

  if (!visibleMessages.length) {
    return normalizedLatest ? [{ role: 'user', content: normalizedLatest }] : [];
  }

  if (shouldKeepRecentUserActionContext(normalizedLatest)) {
    return visibleMessages.slice(-4);
  }

  return normalizedLatest ? [{ role: 'user', content: normalizedLatest }] : visibleMessages.slice(-1);
}

function normalizeDevActionName(name) {
  const normalized = String(name || '').trim();
  const lowered = normalized.toLowerCase();
  if (!normalized) return normalized;
  if (lowered === 'generate_image') return 'generate_png';
  if (lowered === 'websearch') return 'web_search';
  if (lowered === 'share-file' || lowered === 'sharefile' || lowered === 'upload_file' || lowered === 'publish_file') {
    return 'share_file';
  }
  if (lowered === 'list-stored-files' || lowered === 'list_files' || lowered === 'stored_files' || lowered === 'listfiles') {
    return 'list_stored_files';
  }
  if (lowered === 'list_resources' || lowered === 'list-resource' || lowered === 'list_resource' || lowered === 'list_conversation_resources') {
    return 'list_resources';
  }
  if (lowered === 'get_latest_resource' || lowered === 'latest_resource' || lowered === 'get-latest-resource') {
    return 'get_latest_resource';
  }
  if (lowered === 'send-email' || lowered === 'send_mail' || lowered === 'mail_user' || lowered === 'email_user') {
    return 'send_email';
  }
  if (lowered === 'email_latest_resource' || lowered === 'send_latest_resource_email' || lowered === 'latest_resource_email') {
    return 'email_latest_resource';
  }
  if (lowered === 'email-resource' || lowered === 'emailresource' || lowered === 'send_resource_email' || lowered === 'resource_email') {
    return 'email_resource';
  }
  if (lowered === 'schedule-email' || lowered === 'schedule_mail' || lowered === 'mail_later' || lowered === 'delayed_email') {
    return 'schedule_email';
  }
  if (lowered === 'schedule_resource_email' || lowered === 'schedule-resource-email' || lowered === 'resource_email_later') {
    return 'schedule_resource_email';
  }
  if (lowered === 'schedule_latest_resource_email' || lowered === 'latest_resource_email_later') {
    return 'schedule_latest_resource_email';
  }
  if (lowered === 'list_scheduled_emails' || lowered === 'scheduled_emails' || lowered === 'list-mail-jobs') {
    return 'list_scheduled_emails';
  }
  if (lowered === 'cancel_scheduled_email' || lowered === 'cancel-mail-job' || lowered === 'cancel_scheduled_mail') {
    return 'cancel_scheduled_email';
  }
  if (lowered === 'zip_and_email' || lowered === 'zip-email' || lowered === 'bundle_and_email') {
    return 'zip_and_email';
  }
  if (lowered === 'email_file' || lowered === 'mail_file' || lowered === 'share_and_email_file') {
    return 'share_file';
  }
  return normalized;
}

function normalizeDevActionArgs(actionName, rawAction) {
  const action = rawAction && typeof rawAction === 'object' ? rawAction : {};
  const args = action.arguments && typeof action.arguments === 'object'
    ? { ...action.arguments }
    : action.input && typeof action.input === 'object'
      ? { ...action.input }
    : { ...action };

  delete args.action;
  delete args.name;
  delete args.arguments;
  delete args.input;

  if (actionName === 'generate_pdf' && Array.isArray(args.sections)) {
    args.sections = args.sections.map((section, index) => {
      const images = Array.isArray(section?.images)
        ? section.images.filter(Boolean)
        : [section?.image].filter(Boolean);
      return {
        heading: String(section?.heading || section?.title || `Section ${index + 1}`).trim(),
        text: String(section?.text || section?.content || '').trim(),
        images,
      };
    });
  }

  if (actionName === 'generate_png') {
    if (!args.outputPath) {
      args.outputPath = args.imagePath || args.path || null;
    }
    if (!args.text) {
      args.text = args.imageDescription || args.prompt || args.imageType || 'Illustration A11';
    }
    if (!args.width || !args.height) {
      const sizeMatch = /^(\d{2,4})\s*[xX]\s*(\d{2,4})$/.exec(String(args.imageSize || '').trim());
      if (sizeMatch) {
        args.width = Number(args.width || sizeMatch[1]);
        args.height = Number(args.height || sizeMatch[2]);
      }
    }
  }

  if (actionName === 'download_file' && !args.outputPath && args.path) {
    args.outputPath = args.path;
  }

  if (actionName === 'share_file') {
    if (!args.path) {
      args.path = args.outputPath || args.filePath || args.attachmentPath || null;
    }
    if (!args.emailTo) {
      args.emailTo = args.to || args.email || args.recipient || args.recipients || '';
    }
    if (!args.emailSubject) {
      args.emailSubject = args.subject || '';
    }
    if (!args.emailMessage) {
      args.emailMessage = args.message || args.body || args.text || '';
    }
  }

  if (actionName === 'send_email') {
    if (!args.to) {
      args.to = args.emailTo || args.email || args.recipient || args.recipients || '';
    }
    if (!args.subject) {
      args.subject = args.emailSubject || '';
    }
    if (!args.message) {
      args.message = args.emailMessage || args.body || args.text || args.content || '';
    }
    if (!args.path) {
      args.path = args.outputPath || args.filePath || args.attachmentPath || null;
    }
    if (!Array.isArray(args.paths) && Array.isArray(args.attachments)) {
      const attachmentPaths = args.attachments
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') return item.path || '';
          return '';
        })
        .filter(Boolean);
      if (attachmentPaths.length) {
        args.paths = attachmentPaths;
      }
    }
  }

  if (actionName === 'email_resource') {
    if (!args.resourceId) {
      args.resourceId = args.resource_id || args.id || args.conversationResourceId || null;
    }
    if (!args.to) {
      args.to = args.emailTo || args.email || args.recipient || args.recipients || '';
    }
    if (!args.subject) {
      args.subject = args.emailSubject || '';
    }
    if (!args.message) {
      args.message = args.emailMessage || args.body || args.text || args.content || '';
    }
    if (args.attachToEmail == null && args.asAttachment != null) {
      args.attachToEmail = args.asAttachment;
    }
  }

  if (actionName === 'email_latest_resource') {
    if (!args.to) {
      args.to = args.emailTo || args.email || args.recipient || args.recipients || '';
    }
    if (!args.subject) {
      args.subject = args.emailSubject || '';
    }
    if (!args.message) {
      args.message = args.emailMessage || args.body || args.text || args.content || '';
    }
    if (!args.kind) {
      args.kind = args.resourceKind || args.type || '';
    }
    if (!args.conversationId) {
      args.conversationId = args.convId || args.sessionId || null;
    }
  }

  if (actionName === 'list_resources') {
    if (!args.conversationId) {
      args.conversationId = args.convId || args.sessionId || null;
    }
    if (!args.kind) {
      args.kind = args.resourceKind || args.type || '';
    }
  }

  if (actionName === 'get_latest_resource') {
    if (!args.conversationId) {
      args.conversationId = args.convId || args.sessionId || null;
    }
    if (!args.kind) {
      args.kind = args.resourceKind || args.type || '';
    }
  }

  if (actionName === 'schedule_email') {
    if (!args.to) {
      args.to = args.emailTo || args.email || args.recipient || args.recipients || '';
    }
    if (!args.subject) {
      args.subject = args.emailSubject || '';
    }
    if (!args.message) {
      args.message = args.emailMessage || args.body || args.text || args.content || '';
    }
    if (!args.path) {
      args.path = args.outputPath || args.filePath || args.attachmentPath || null;
    }
  }

  if (actionName === 'schedule_resource_email') {
    if (!args.resourceId) {
      args.resourceId = args.resource_id || args.id || args.conversationResourceId || null;
    }
    if (!args.to) {
      args.to = args.emailTo || args.email || args.recipient || args.recipients || '';
    }
    if (!args.subject) {
      args.subject = args.emailSubject || '';
    }
    if (!args.message) {
      args.message = args.emailMessage || args.body || args.text || args.content || '';
    }
  }

  if (actionName === 'schedule_latest_resource_email') {
    if (!args.to) {
      args.to = args.emailTo || args.email || args.recipient || args.recipients || '';
    }
    if (!args.subject) {
      args.subject = args.emailSubject || '';
    }
    if (!args.message) {
      args.message = args.emailMessage || args.body || args.text || args.content || '';
    }
    if (!args.kind) {
      args.kind = args.resourceKind || args.type || '';
    }
    if (!args.conversationId) {
      args.conversationId = args.convId || args.sessionId || null;
    }
  }

  if (actionName === 'cancel_scheduled_email' && !args.jobId) {
    args.jobId = args.id || args.scheduledId || args.job || null;
  }

  if (actionName === 'zip_and_email' && !args.inputPaths) {
    args.inputPaths = Array.isArray(args.paths) ? args.paths : [];
  }

  if (actionName === 'list_stored_files' && !args.limit) {
    args.limit = args.max || args.count || args.top || args.n || undefined;
  }

  return args;
}

function normalizeActionEnvelopeShape(candidate, defaults = {}) {
  const payload = candidate && typeof candidate === 'object' ? { ...candidate } : null;
  if (!payload) return null;

  let actions = [];
  if (Array.isArray(payload.actions)) {
    actions = payload.actions;
  } else if (payload.result && typeof payload.result === 'object') {
    actions = [payload.result];
  } else if (payload.action || payload.name) {
    actions = [payload];
  } else {
    return null;
  }

  const normalizedActions = actions
    .filter((action) => action && typeof action === 'object')
    .map((action) => {
      const actionName = normalizeDevActionName(action.action || action.name);
      return {
        action: actionName,
        arguments: normalizeDevActionArgs(actionName, action),
      };
    })
    .filter((action) => action.action);

  if (!normalizedActions.length) return null;

  return {
    mode: 'actions',
    goal: String(payload.goal || payload.title || defaults.goal || '').trim() || undefined,
    conversationId: normalizeConversationId(payload.conversationId || defaults.conversationId),
    userId: String(payload.userId || defaults.userId || '').trim() || undefined,
    actions: normalizedActions,
  };
}

function extractJsonObjectCandidate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const candidate = fencedMatch[1].trim();
    if (candidate) return candidate;
  }

  if (raw.startsWith('{') && raw.endsWith('}')) {
    return raw;
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim();
  }

  return '';
}

function parseAssistantActionEnvelope(value, defaults = {}) {
  const raw = extractJsonObjectCandidate(value);
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(raw);
    return normalizeActionEnvelopeShape(parsed, defaults);
  } catch {
    return null;
  }
}

function parseAssistantEnvelope(value, defaults = {}) {
  const raw = extractJsonObjectCandidate(value);
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.mode === 'actions') {
      return normalizeActionEnvelopeShape(parsed, defaults);
    }

    if (parsed.mode === 'final') {
      return {
        version: 'a11-envelope-1',
        mode: 'final',
        answer: normalizeAssistantOutput(parsed.answer || parsed.message || parsed.content || ''),
        conversationId: normalizeConversationId(parsed.conversationId || defaults.conversationId),
        userId: String(parsed.userId || defaults.userId || '').trim() || undefined,
      };
    }

    if (parsed.mode === 'need_user') {
      return {
        version: 'a11-envelope-1',
        mode: 'need_user',
        question: String(parsed.question || parsed.message || '').trim(),
        choices: Array.isArray(parsed.choices) ? parsed.choices.map((choice) => String(choice || '').trim()).filter(Boolean) : [],
        id: String(parsed.id || '').trim() || undefined,
        conversationId: normalizeConversationId(parsed.conversationId || defaults.conversationId),
        userId: String(parsed.userId || defaults.userId || '').trim() || undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function formatNeedUserEnvelope(envelope) {
  const question = String(envelope?.question || '').trim() || 'J’ai besoin d’une precision.';
  const choices = Array.isArray(envelope?.choices)
    ? envelope.choices.map((choice) => String(choice || '').trim()).filter(Boolean)
    : [];
  if (!choices.length) return question;
  return `${question}\n\nChoix: ${choices.join(' | ')}`;
}

function applyAssistantTextToPayload(payload, content, extras = null) {
  const normalizedContent = normalizeAssistantOutput(content);
  if (!payload || typeof payload !== 'object') {
    return toSimpleAssistantCompletion(normalizedContent);
  }

  if (Array.isArray(payload.choices) && payload.choices[0]) {
    const choice = payload.choices[0];
    if (choice.message && typeof choice.message === 'object') {
      choice.message.content = normalizedContent;
      choice.message.role = choice.message.role || 'assistant';
    } else {
      choice.message = { role: 'assistant', content: normalizedContent };
    }
  } else {
    payload.choices = [{
      index: 0,
      message: { role: 'assistant', content: normalizedContent },
      finish_reason: 'stop',
    }];
  }

  if (extras && typeof extras === 'object') {
    payload.a11Agent = {
      ...(payload.a11Agent && typeof payload.a11Agent === 'object' ? payload.a11Agent : {}),
      ...extras,
    };
  }

  return payload;
}

async function resolveAssistantActionEnvelope({
  content,
  allowDevActions = false,
  conversationId,
  userId,
  requestOrigin = '',
  executionContext = null,
  messages = [],
}) {
  const envelope = parseAssistantActionEnvelope(content, { conversationId, userId });
  if (!envelope) {
    return {
      content: normalizeAssistantOutput(content),
      envelope: null,
      blocked: false,
      executed: false,
      cerbere: null,
      extras: null,
    };
  }

  if (!allowDevActions) {
    return {
      content: buildDevModeRequiredReply(),
      envelope,
      blocked: true,
      executed: false,
      cerbere: null,
      extras: {
        blocked: true,
        actionCount: envelope.actions.length,
      },
    };
  }

  const cerbere = await runActionsEnvelope(envelope, executionContext || {});
  const publicImageUrl = extractImagePathFromCerbere(cerbere, requestOrigin);
  const explanation = await generateDevActionReply({
    messages,
    cerbere,
    imagePath: publicImageUrl,
  });

  appendConversationLog({
    type: 'agent_actions',
    userId: String(userId || envelope.userId || '').trim() || null,
    conversationId: envelope.conversationId || normalizeConversationId(conversationId),
    envelope,
    explanation,
    imagePath: publicImageUrl,
    cerbere,
  });

  return {
    content: explanation,
    envelope,
    blocked: false,
    executed: true,
    cerbere,
    extras: {
      executed: true,
      actionCount: Array.isArray(cerbere?.results) ? cerbere.results.length : 0,
      imagePath: publicImageUrl || null,
    },
  };
}

const DEV_ACTION_REPLY_SYSTEM_PROMPT = [
  'Tu es A11.',
  'Tu reformules le resultat final d\'une demande executee en mode dev.',
  'Reponds en francais, en 1 ou 2 phrases courtes maximum.',
  'Ne mentionne jamais Cerbere, Qflush, JSON, outil, pipeline, phase, log, backend ou mode dev.',
  'Si tout a reussi, confirme simplement que c\'est fait.',
  'Si une partie echoue, explique brievement la vraie raison du blocage.',
  'Si plusieurs actions ont ete executees, donne seulement le resultat global.',
  'Si un fichier, PDF, image, archive ou email a ete produit, dis juste qu\'il est pret ou envoye.',
  'Si la demande concerne internet, resume directement les informations utiles trouvees.',
  'N\'invente rien.'
].join(' ');

function stripDevEnginePrefix(value) {
  return String(value || '').replace(/^\s*\[DEV_ENGINE\]\s*/i, '').trim();
}

function getLatestUserMessageFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
      return stripDevEnginePrefix(message.content);
    }
  }
  return '';
}

function isThinDevFinalReply(value) {
  const normalized = normalizeAssistantOutput(value).toLowerCase();
  if (!normalized) return true;
  return [
    'ok',
    'fait',
    'termine',
    'termine.',
    'cest fait',
    'cest fait.',
    "c'est fait",
    "c'est fait.",
  ].includes(normalized);
}

function isUnsafeDevFollowupReply(value) {
  const normalized = normalizeAssistantOutput(value);
  if (!normalized) return true;
  if (parseAssistantActionEnvelope(normalized)) return true;
  if (/\[[^\]]+\]/.test(normalized)) return true;
  if (/voici le resultat final/i.test(normalized)) return true;
  if (/cerbere|qflush|json|pipeline|backend|tool_results|allowedactions|workspaceroot|tool/i.test(normalized)) return true;
  return false;
}

function isUnsafeAgentFinalText(value) {
  const normalized = normalizeAssistantOutput(value);
  if (!normalized) return true;
  if (parseAssistantEnvelope(normalized)) return true;
  if (parseAssistantActionEnvelope(normalized)) return true;
  if (/^\s*\{[\s\S]*"mode"\s*:\s*"(?:final|need_user|actions)"/i.test(normalized)) return true;
  if (/\[tools\]|\[context\]|\[tool_results\]|\[user_prompt\]/i.test(normalized)) return true;
  if (/tool_results|allowedactions|workspaceroot|cerbere|qflush|pipeline|backend interne/i.test(normalized)) return true;
  return false;
}

function sanitizeDevActionError(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const line = raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)[0] || raw;
  return line.length > 180 ? `${line.slice(0, 177).trimEnd()}...` : line;
}

function extractPrimaryResultLabel(entry) {
  const result = entry?.result && typeof entry.result === 'object' ? entry.result : {};
  const outputPath = String(
    result.outputPath
      || result.path
      || result.filePath
      || result.savedAs
      || result?.file?.path
      || result?.resource?.path
      || ''
  ).trim();
  const filename = String(
    result?.file?.filename
      || result?.resource?.filename
      || result?.artifact?.filename
      || result?.zip?.outputPath
      || ''
  ).trim();
  if (filename) {
    return path.basename(filename);
  }
  if (outputPath) {
    return path.basename(outputPath);
  }
  return '';
}

function extractPrimaryRecipient(entry) {
  const result = entry?.result && typeof entry.result === 'object' ? entry.result : {};
  const rawRecipients = []
    .concat(Array.isArray(result?.to) ? result.to : [])
    .concat(Array.isArray(result?.mail?.to) ? result.mail.to : [])
    .concat(
      result?.to && !Array.isArray(result.to) ? [result.to] : [],
      result?.mail?.to && !Array.isArray(result.mail.to) ? [result.mail.to] : [],
      result?.mail?.emailTo ? [result.mail.emailTo] : []
    )
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return rawRecipients[0] || '';
}

function extractPrimarySharedLink(entry) {
  const directLink = String(entry?.link || entry?.url || '').trim();
  if (directLink) return directLink;
  const result = entry?.result && typeof entry.result === 'object' ? entry.result : {};
  return String(
    result?.url
    || result?.file?.downloadUrl
    || result?.file?.url
    || result?.conversationResource?.downloadUrl
    || result?.conversationResource?.url
    || ''
  ).trim();
}

function extractPrimaryExpiry(entry) {
  const directExpiry = String(entry?.expiresAt || entry?.expires_at || '').trim();
  if (directExpiry) return directExpiry;
  const result = entry?.result && typeof entry.result === 'object' ? entry.result : {};
  return String(
    result?.expiresAt
    || result?.file?.expiresAt
    || result?.conversationResource?.expiresAt
    || result?.record?.expiresAt
    || ''
  ).trim();
}

function buildTemporaryLinkSuffix(entry) {
  const link = extractPrimarySharedLink(entry);
  if (!link) return '';
  const expiresAt = normalizeOptionalTimestamp(extractPrimaryExpiry(entry));
  return expiresAt
    ? ` Lien valable jusqu'a ${expiresAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} : ${link}`
    : ` Lien de telechargement : ${link}`;
}

function buildDevActionResultDetails(action, result = {}) {
  if (!result || typeof result !== 'object') return undefined;

  if (action === 'web_search') {
    const entries = Array.isArray(result.results) ? result.results : [];
    return {
      query: String(result.query || '').trim() || undefined,
      results: entries.slice(0, 5).map((entry) => ({
        title: String(entry?.title || '').trim() || undefined,
        url: String(entry?.url || '').trim() || undefined,
        snippet: truncateTemporalPreview(entry?.snippet, 180) || undefined,
      })),
    };
  }

  if (action === 'web_fetch') {
    const contentPreview = truncateTemporalPreview(
      result.content || result.text || result.markdown || result.summary || '',
      1200
    );
    return {
      url: String(result.url || '').trim() || undefined,
      title: String(result.title || '').trim() || undefined,
      status: Number(result.status || 0) || undefined,
      contentPreview: contentPreview || undefined,
    };
  }

  return undefined;
}

function buildDevActionReplyContext(cerbere, imagePath = null, userRequest = '') {
  const rawResults = Array.isArray(cerbere?.results)
    ? cerbere.results
    : (Array.isArray(cerbere?.actions) ? cerbere.actions : []);
  const results = rawResults.slice(0, 12).map((entry) => {
    const result = entry?.result && typeof entry.result === 'object' ? entry.result : {};
    const action = String(entry?.name || entry?.tool || entry?.action || 'action').trim() || 'action';
    const explicitOk = typeof result.ok === 'boolean'
      ? result.ok
      : (typeof entry?.ok === 'boolean' ? entry.ok : null);
    const error = sanitizeDevActionError(entry?.error || result?.error || result?.message || '');
    const ok = explicitOk === null ? !error : explicitOk;
    return {
      action,
      ok,
      label: extractPrimaryResultLabel(entry) || undefined,
      to: extractPrimaryRecipient(entry) || undefined,
      link: extractPrimarySharedLink(entry) || undefined,
      expiresAt: extractPrimaryExpiry(entry) || undefined,
      mailOnly: result?.mailOnly === true || undefined,
      storageFallbackReason: String(result?.storageFallbackReason || '').trim() || undefined,
      count: Number(
        result?.count
        || (Array.isArray(result?.jobs) ? result.jobs.length : 0)
        || (Array.isArray(result?.resources) ? result.resources.length : 0)
        || (Array.isArray(result?.files) ? result.files.length : 0)
        || (Array.isArray(result?.results) ? result.results.length : 0)
      ) || undefined,
      error: error || undefined,
      details: buildDevActionResultDetails(action, result),
    };
  });
  const successCount = results.filter((entry) => entry.ok).length;
  const failureCount = results.length - successCount;
  return {
    userRequest: stripDevEnginePrefix(userRequest),
    imageReady: Boolean(imagePath),
    successCount,
    failureCount,
    results,
  };
}

function shouldPreferInterpretiveDevReply(context) {
  const results = Array.isArray(context?.results) ? context.results : [];
  return results.some((entry) => entry?.action === 'web_search' || entry?.action === 'web_fetch');
}

function buildDeterministicDevActionReply(context) {
  const results = Array.isArray(context?.results) ? context.results : [];
  if (!results.length) {
    return "Je n'ai rien execute pour cette demande.";
  }

  const successCount = Number(context?.successCount || 0);
  const failureCount = Number(context?.failureCount || 0);
  const firstResult = results[0] || null;
  const firstError = results.find((entry) => !entry.ok);
  const errorReason = sanitizeDevActionError(firstError?.error || '');

  if (failureCount === 0) {
    const okActions = new Set(results.filter((entry) => entry.ok).map((entry) => entry.action));
    const sharedResult = results.find((entry) => entry.ok && entry.action === 'share_file');
    const mailedLatestResult = results.find((entry) => entry.ok && entry.action === 'email_latest_resource');

    if (okActions.has('generate_pdf') && okActions.has('share_file')) {
      if (sharedResult?.mailOnly) {
        return sharedResult?.to
          ? `C'est fait. Le PDF a bien ete cree et envoye a ${sharedResult.to}, mais le stockage temporaire a echoue.`
          : "C'est fait. Le PDF a bien ete cree, mais le stockage temporaire a echoue.";
      }
      return sharedResult?.to
        ? `C'est fait. Le PDF a bien ete cree, stocke et envoye a ${sharedResult.to}.${buildTemporaryLinkSuffix(sharedResult)}`
        : `C'est fait. Le PDF a bien ete cree, stocke dans le bucket et pret au telechargement.${buildTemporaryLinkSuffix(sharedResult)}`;
    }
    if (okActions.has('generate_png') && okActions.has('share_file')) {
      if (sharedResult?.mailOnly) {
        return sharedResult?.to
          ? `C'est fait. L'image a bien ete creee et envoyee a ${sharedResult.to}, mais le stockage temporaire a echoue.`
          : "C'est fait. L'image a bien ete creee, mais le stockage temporaire a echoue.";
      }
      return sharedResult?.to
        ? `C'est fait. L'image a bien ete creee, stockee et envoyee a ${sharedResult.to}.${buildTemporaryLinkSuffix(sharedResult)}`
        : `C'est fait. L'image a bien ete creee, stockee dans le bucket et prete au telechargement.${buildTemporaryLinkSuffix(sharedResult)}`;
    }
    if (mailedLatestResult?.to) {
      return `C'est fait. Le dernier fichier stocke a bien ete envoye a ${mailedLatestResult.to}.`;
    }

    if (results.length > 1) {
      return context?.imageReady
        ? "C'est fait. La demande a bien ete executee et le resultat est pret."
        : "C'est fait. La demande a bien ete executee.";
    }

    if (firstResult?.action === 'generate_png') return "C'est fait. L'image est prete.";
    if (firstResult?.action === 'generate_pdf') return "C'est fait. Le PDF est pret.";
    if (firstResult?.action === 'send_email') {
      return firstResult?.to
        ? `C'est fait. Le mail a bien ete envoye a ${firstResult.to}.`
        : "C'est fait. Le mail a bien ete envoye.";
    }
    if (firstResult?.action === 'share_file') {
      if (firstResult?.mailOnly) {
        return firstResult?.to
          ? `C'est fait. Le fichier a bien ete envoye a ${firstResult.to}, mais le stockage temporaire a echoue.`
          : "C'est fait. Le fichier a bien ete prepare, mais le stockage temporaire a echoue.";
      }
      return firstResult?.to
        ? `C'est fait. Le fichier a bien ete partage et envoye a ${firstResult.to}.${buildTemporaryLinkSuffix(firstResult)}`
        : `C'est fait. Le fichier a bien ete partage.${buildTemporaryLinkSuffix(firstResult)}`;
    }
    if (firstResult?.action === 'web_search') {
      return firstResult?.count
        ? `J'ai trouve ${firstResult.count} resultat${firstResult.count > 1 ? 's' : ''} sur internet.`
        : "J'ai lance la recherche sur internet.";
    }
    if (firstResult?.action === 'web_fetch') return "J'ai consulte la page demandee.";
    if (firstResult?.action === 'zip_and_email') return "C'est fait. L'archive a ete creee et envoyee.";
    if (firstResult?.action === 'list_scheduled_emails') {
      if (!firstResult?.count) return "C'est fait. Il n'y a aucun email planifie pour le moment.";
      return firstResult.count === 1
        ? "C'est fait. J'ai retrouve 1 email planifie."
        : `C'est fait. J'ai retrouve ${firstResult.count} emails planifies.`;
    }
    if (firstResult?.action === 'list_resources') {
      if (!firstResult?.count) return "C'est fait. Je n'ai trouve aucune ressource pour le moment.";
      return firstResult.count === 1
        ? "C'est fait. J'ai retrouve 1 ressource."
        : `C'est fait. J'ai retrouve ${firstResult.count} ressources.`;
    }
    if (firstResult?.action === 'list_stored_files') {
      if (!firstResult?.count) return "C'est fait. Je n'ai trouve aucun fichier stocke pour le moment.";
      return firstResult.count === 1
        ? "C'est fait. J'ai retrouve 1 fichier stocke."
        : `C'est fait. J'ai retrouve ${firstResult.count} fichiers stockes.`;
    }
    if (firstResult?.action === 'schedule_email' || firstResult?.action === 'schedule_resource_email' || firstResult?.action === 'schedule_latest_resource_email') {
      return "C'est bon. L'envoi a bien ete planifie.";
    }
    return context?.imageReady
      ? "C'est fait. Le resultat est pret."
      : "C'est fait. L'action demandee a bien ete executee.";
  }

  if (successCount > 0) {
    return errorReason
      ? `J'ai bien avance, mais je n'ai pas pu tout terminer : ${errorReason}`
      : "J'ai bien avance, mais je n'ai pas pu tout terminer.";
  }

  return errorReason
    ? `Je n'ai pas pu executer la demande : ${errorReason}`
    : "Je n'ai pas pu executer la demande.";
}

async function generateDevActionReply({ messages = [], cerbere, imagePath = null }) {
  const latestUserMessage = getLatestUserMessageFromMessages(messages);
  const context = buildDevActionReplyContext(cerbere, imagePath, latestUserMessage);
  const fallbackReply = buildDeterministicDevActionReply(context);
  if (!context.results.length) {
    return fallbackReply;
  }
  if (Number(context.failureCount || 0) === 0 && !shouldPreferInterpretiveDevReply(context)) {
    return fallbackReply;
  }

  const promptMessages = [
    { role: 'system', content: DEV_ACTION_REPLY_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Demande utilisateur: ${context.userRequest || '(non fournie)'}`,
        '',
        'Resultat brut:',
        JSON.stringify(context, null, 2),
        '',
        'Redige maintenant la reponse finale utilisateur.'
      ].join('\n')
    }
  ];

  const qflushChatFlow = getQflushChatFlow();
  if (qflushChatFlow) {
    try {
      const qflushResult = await runQflushFlow(qflushChatFlow, {
        prompt: context.userRequest || 'Confirme le resultat final.',
        messages: promptMessages,
        systemPrompt: DEV_ACTION_REPLY_SYSTEM_PROMPT,
        request: {
          mode: 'dev_followup_confirmation',
          userRequest: context.userRequest || null,
        },
      });
      const qflushText = normalizeAssistantOutput(extractAssistantText(qflushResult));
      if (qflushText && !isUnsafeDevFollowupReply(qflushText) && !isThinDevFinalReply(qflushText)) {
        return qflushText;
      }
    } catch (error_) {
      console.warn('[A11][dev-followup] qflush follow-up failed:', error_?.message || error_);
    }
  }

  try {
    const llmText = normalizeAssistantOutput(await callChatBackend(promptMessages, {
      provider: getMemorySummaryProvider(),
      model: process.env.MEMORY_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    }));
    if (llmText && !isUnsafeDevFollowupReply(llmText) && !isThinDevFinalReply(llmText)) {
      return llmText;
    }
  } catch (error_) {
    console.warn('[A11][dev-followup] llm follow-up failed:', error_?.message || error_);
  }

  return fallbackReply;
}

function isSiwisStatusQuestion(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  const mentionsSiwis = /siwis|piper|tts|voix/.test(text);
  const asksStatus = /marche|fonctionne|disponible|status|etat|up|down|ok/.test(text);
  return mentionsSiwis && asksStatus;
}

async function getSiwisHealthSnapshot() {
  const port = Number(process.env.PORT || 3000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const response = await fetch(`${baseUrl}/api/tts/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(3000),
  });
  const raw = await response.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw: String(raw).slice(0, 400) };
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function formatSiwisStatusReply(snapshot) {
  if (snapshot?.ok && snapshot?.body?.ok) {
    const mode = String(snapshot.body.mode || 'unknown');
    const modelPath = String(snapshot.body.modelPath || '').trim();
    const modelLabel = modelPath ? ` (${modelPath.split('/').pop()})` : '';
    return `Oui, SIWIS fonctionne actuellement. Mode: ${mode}${modelLabel}.`;
  }

  const errorCode = String(snapshot?.body?.error || `http_${snapshot?.status || 'unknown'}`);
  return `Non, SIWIS est indisponible actuellement (raison: ${errorCode}).`;
}

function toSimpleAssistantCompletion(content, model = 'a11-runtime') {
  return {
    id: `chatcmpl-runtime-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

function getCompletionsUrlForRequest(body) {
  const provider = String(body?.provider || '').trim().toLowerCase();
  if (provider === 'local') {
    return getLocalCompletionsUrl();
  }
  return getOpenAICompletionsUrl();
}

function getQflushChatFlow() {
  return String(process.env.QFLUSH_CHAT_FLOW || '').trim();
}

function getQflushMemorySummaryFlow() {
  return String(process.env.QFLUSH_MEMORY_SUMMARY_FLOW || DEFAULT_QFLUSH_MEMORY_SUMMARY_FLOW).trim();
}

function isBuiltInMemorySummaryFlow(flowName) {
  return String(flowName || '').trim() === DEFAULT_QFLUSH_MEMORY_SUMMARY_FLOW;
}

function getMemorySummaryProvider() {
  const configured = String(process.env.MEMORY_SUMMARY_PROVIDER || '').trim().toLowerCase();
  if (configured === 'openai' || configured === 'local') {
    return configured;
  }
  return getLocalLlamaCompletionUrl() || getLocalCompletionsUrl() ? 'local' : 'openai';
}

function shouldUseQflushChat(body) {
  const provider = String(body?.provider || '').trim().toLowerCase();
  const qflushChatFlow = getQflushChatFlow();
  const defaultUpstream = String(process.env.DEFAULT_UPSTREAM || '').trim().toLowerCase();

  if (provider === 'qflush') return true;
  if (!qflushChatFlow) return false;
  if (defaultUpstream === 'qflush') return true;

  const hasLocalLlama = !!getLocalLlamaCompletionUrl() || !!getLocalCompletionsUrl();
  return provider === 'local' && !hasLocalLlama;
}

function extractAssistantText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return normalizeAssistantOutput(payload);
  if (typeof payload.output === 'string') return normalizeAssistantOutput(payload.output);
  if (typeof payload.response === 'string') return normalizeAssistantOutput(payload.response);
  if (typeof payload.content === 'string') return normalizeAssistantOutput(payload.content);
  if (typeof payload.text === 'string') return normalizeAssistantOutput(payload.text);
  if (payload.result && typeof payload.result === 'object') {
    return extractAssistantText(payload.result);
  }
  if (Array.isArray(payload.messages)) {
    const assistantMsg = [...payload.messages].reverse().find((msg) => msg?.role === 'assistant' && typeof msg.content === 'string');
    if (assistantMsg) return normalizeAssistantOutput(assistantMsg.content);
  }
  if (Array.isArray(payload.choices) && payload.choices[0]?.message?.content) {
    return normalizeAssistantOutput(String(payload.choices[0].message.content));
  }
  return '';
}

async function callChatBackend(messages, options = {}) {
  const provider = String(options.provider || getMemorySummaryProvider()).trim().toLowerCase();
  const model = String(options.model || process.env.MEMORY_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();

  if (provider === 'local') {
    const localLlamaCompletionUrl = getLocalLlamaCompletionUrl();
    if (localLlamaCompletionUrl) {
      const prompt = buildPromptFromMessages(messages);
      const upstreamRes = await axios({
        method: 'post',
        url: localLlamaCompletionUrl,
        headers: { 'content-type': 'application/json' },
        data: {
          prompt,
          n_predict: Number(process.env.MEMORY_SUMMARY_MAX_TOKENS || 250),
          stream: false
        },
        timeout: 60000,
      });
      return extractLocalCompletionContent(upstreamRes.data).trim();
    }
  }

  const upstreamUrl = getCompletionsUrlForRequest({ provider: provider === 'local' ? 'local' : 'openai' });
  if (!upstreamUrl) {
    throw new Error('No upstream available for memory summary flow');
  }

  const upstreamRes = await axios({
    method: 'post',
    url: upstreamUrl,
    headers: buildOpenAIProxyHeaders({}, { provider }),
    data: {
      model,
      messages,
      stream: false,
      temperature: 0.2,
    },
    timeout: 60000,
  });

  return extractAssistantText(upstreamRes.data).trim();
}

async function runBuiltInLogicalMemorySummary(payload) {
  const previousSummary = String(payload?.previousSummary || '').trim();
  const latestUserMessage = String(payload?.latestUserMessage || '').trim();
  const recentMessages = Array.isArray(payload?.recentMessages) ? payload.recentMessages : [];

  const promptMessages = [
    {
      role: 'system',
      content: 'Tu mets a jour la memoire logique d\'un assistant. Resume uniquement les informations durables et utiles: identite, objectifs, preferences, contraintes, faits de vie, contexte emotionnel stable, besoins. Reste court, factuel, structure. N\'invente rien. Si une information n\'est pas durable ou utile, ignore-la.'
    },
    {
      role: 'user',
      content: [
        'Memoire actuelle:',
        previousSummary || '(vide)',
        '',
        'Historique recent:',
        recentMessages.map((msg) => `${msg.role}: ${msg.content}`).join('\n') || '(vide)',
        '',
        'Nouveau message utilisateur:',
        latestUserMessage,
        '',
        'Met a jour la memoire en quelques lignes courtes.'
      ].join('\n')
    }
  ];

  const summary = await callChatBackend(promptMessages, {
    provider: getMemorySummaryProvider(),
    model: process.env.MEMORY_SUMMARY_MODEL || undefined,
  });

  return { ok: true, output: summary };
}

async function runLogicalMemorySummaryFlow(payload = {}) {
  const flow = String(payload.flow || getQflushMemorySummaryFlow()).trim();
  if (isBuiltInMemorySummaryFlow(flow)) {
    return runBuiltInLogicalMemorySummary(payload);
  }
  return runQflushFlow(flow, payload);
}

function buildOpenAIProxyHeaders(reqHeaders, options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const headers = reqHeaders ? { ...reqHeaders } : {};
  delete headers.host;
  delete headers.authorization;
  delete headers.Authorization;
  delete headers['x-nez-token'];
  delete headers['X-NEZ-TOKEN'];
  delete headers.cookie;
  delete headers.Cookie;
  delete headers['content-length'];
  delete headers['Content-Length'];
  delete headers['transfer-encoding'];
  delete headers['Transfer-Encoding'];
  headers['content-type'] = 'application/json';
  if (provider !== 'local' && process.env.OPENAI_API_KEY) {
    headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  }
  return headers;
}

function appendChatTurnLogSafe(body, responsePayload, defaultModel, userId = null) {
  try {
    const reqBody = body || {};
    const convId = reqBody.conversationId || reqBody.convId || reqBody.sessionId || 'default';
    const messages = Array.isArray(reqBody.messages) ? reqBody.messages : [];
    appendConversationLog({
      type: 'chat_turn',
      userId: String(userId || reqBody._user || '').trim() || null,
      conversationId: convId,
      request: {
        model: reqBody.model || defaultModel,
        messages,
      },
      response: responsePayload,
    });
  } catch (e) {
    console.warn('[A11][memory] log chat_turn failed:', e?.message);
  }
}

async function loadUserMemoryContext(userId, latestUserMessage, conversationId) {
  const normalizedUserId = String(userId || '').trim();
  const normalizedLatestMessage = String(latestUserMessage || '').trim();
  const normalizedConversationId = normalizeConversationId(conversationId);

  if (!normalizedUserId) {
    return {
      storedMessages: [],
      logicalMemory: '',
      structuredFacts: [],
      structuredTasks: [],
      structuredFiles: [],
      conversationResources: [],
      conversationResourceContext: '',
      structuredMemoryContext: '',
    };
  }

  if (normalizedLatestMessage) {
    await saveChatMemoryMessage(normalizedUserId, 'user', normalizedLatestMessage, normalizedConversationId);
    await saveStructuredMemoryFromMessage(normalizedUserId, normalizedLatestMessage);
  }

  const storedMessages = await getRecentChatMemory(normalizedUserId, normalizedConversationId, CHAT_MEMORY_LIMIT);
  let logicalMemory = await getLogicalUserMemory(normalizedUserId);
  const messageCount = await countUserMessages(normalizedUserId);

  if (shouldRefreshLogicalMemory(messageCount)) {
    const refreshed = await refreshLogicalUserMemory(normalizedUserId, normalizedLatestMessage, storedMessages);
    logicalMemory = refreshed || logicalMemory;
  }

  if (messageCount > 0 && messageCount % 25 === 0) {
    pruneChatMemory().catch((error_) => {
      console.warn('[DB] chat memory prune failed:', error_?.message);
    });
  }

  if (messageCount > 0 && messageCount % MEMORY_PURGE_EVERY_USER_MESSAGES === 0) {
    pruneStructuredMemory(normalizedUserId).catch((error_) => {
      console.warn('[DB] structured memory prune failed:', error_?.message);
    });
  }

  const [structuredFacts, structuredTasks, structuredFiles, conversationResources] = await Promise.all([
    getUserFacts(normalizedUserId, FACT_MEMORY_LIMIT),
    getUserTasks(normalizedUserId, TASK_MEMORY_LIMIT),
    getUserFilesMemory(normalizedUserId, FILE_MEMORY_LIMIT),
    listConversationResources(normalizedUserId, {
      conversationId: normalizedConversationId,
      limit: 4,
    }),
  ]);

  markFactsAsUsed(normalizedUserId, structuredFacts).catch((error_) => {
    console.warn('[DB] mark facts as used failed:', error_?.message);
  });

  return {
    storedMessages,
    logicalMemory,
    structuredFacts,
    structuredTasks,
    structuredFiles,
    conversationResources,
    conversationResourceContext: buildConversationResourceContext(conversationResources, { maxResources: 4 }),
    structuredMemoryContext: buildStructuredMemoryContext({
      facts: structuredFacts,
      tasks: structuredTasks,
      files: structuredFiles,
    }),
  };
}

function buildChatMessagesWithMemory(baseMessages, logicalMemory, structuredMemoryContext, conversationResourceContext, systemPrompt) {
  const messages = [];
  const normalizedSystemPrompt = String(systemPrompt || '').trim();
  const sanitizedBaseMessages = sanitizePromptMessages(baseMessages);
  const explicitSystemMessages = sanitizedBaseMessages.filter((message) => message.role === 'system');
  const nonSystemMessages = sanitizedBaseMessages.filter((message) => message.role !== 'system');

  if (normalizedSystemPrompt) {
    messages.push({
      role: 'system',
      content: normalizedSystemPrompt
    });
  }

  messages.push(...explicitSystemMessages);

  const temporalSystemMessage = buildTemporalSystemMessage(baseMessages);
  if (temporalSystemMessage) {
    messages.push(temporalSystemMessage);
  }

  const memorySystemMessage = buildMemorySystemMessage(
    logicalMemory,
    structuredMemoryContext,
    conversationResourceContext
  );
  if (memorySystemMessage) {
    messages.push(memorySystemMessage);
  }

  return [...messages, ...nonSystemMessages];
}

const USER_SAFE_AGENT_ACTIONS = Object.freeze([
  'download_file',
  'generate_pdf',
  'generate_png',
  'share_file',
  'list_stored_files',
  'list_resources',
  'get_latest_resource',
  'email_resource',
  'email_latest_resource',
  'send_email',
  'schedule_email',
  'schedule_resource_email',
  'schedule_latest_resource_email',
  'list_scheduled_emails',
  'cancel_scheduled_email',
  'zip_create',
  'zip_and_email',
]);

const INTERNET_SAFE_AGENT_ACTIONS = Object.freeze([
  'web_search',
  'web_fetch',
]);

function buildRequestMessagesFromBody(body) {
  const sourceMessages = Array.isArray(body?.messages) ? body.messages : [];
  const normalizedMessages = sourceMessages
    .filter((message) => normalizeChatRole(message?.role) && typeof message?.content === 'string' && message.content.trim())
    .map((message) => {
      const normalizedTimestamp = normalizeChatTimestamp(message?.ts);
      return {
        role: normalizeChatRole(message.role),
        content: String(message.content || '').trim(),
        ...(normalizedTimestamp ? { ts: normalizedTimestamp.toISOString() } : {}),
      };
    });

  if (normalizedMessages.length) {
    return normalizedMessages;
  }

  const prompt = String(body?.prompt || '').trim();
  if (!prompt) return [];
  return [
    {
      role: 'user',
      content: prompt,
      ts: new Date().toISOString(),
    },
  ];
}

function detectDevModeRequiredReason(body) {
  const latestUserMessage = getLatestUserMessage(body || {});
  const text = String(latestUserMessage || '').trim().toLowerCase();
  if (!text) return null;
  if (body?.a11Dev === true) return null;

  const hasEmailAddress = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  const asksEmail = /(envoi(?:e|s|er)?|mail|email|e-mail|expedie|expédie|transmets?|partage)/i.test(text);
  const asksPdfOrImage = /(pdf|png|image|illustration|photo|document|dossier|fiche|rapport|archive|zip)/i.test(text);
  const asksCreate = /(cree|crée|genere|génère|fabrique|produis|prepare|prépare|fais|fait|construis|realise|réalise)/i.test(text);
  const asksStore = /(stocke|garde|sauvegarde|enregistre|conserve|ajoute).*(donnees|données|ressources|fichiers|mes donnees|mes données|tes donnees|tes données|memoire|mémoire)/i.test(text);
  const asksLatestResource = /(dernier|derniere|dernière|le|la).*(pdf|fichier|document|image|ressource|archive)/i.test(text)
    && /(envoi(?:e|s|er)?|mail|email|e-mail|partage|renvoie|renvoyer)/i.test(text);
  const asksSchedule = /(planifie|programme|plus tard|demain|ce soir|a \d{1,2}h|à \d{1,2}h)/i.test(text)
    && /(mail|email|e-mail|envoi(?:e|s|er)?)/i.test(text);

  if (asksSchedule) return 'planifier un envoi';
  if (hasEmailAddress && asksEmail) return 'envoyer un email';
  if (asksLatestResource) return 'retrouver ou renvoyer une ressource stockee';
  if (asksStore) return 'stocker ou reutiliser des fichiers';
  if (asksCreate && asksPdfOrImage) return 'generer un fichier';
  if (asksEmail && /(pdf|fichier|document|image|piece jointe|pièce jointe|ressource|archive|zip|joint)/i.test(text)) {
    return 'envoyer un fichier ou une piece jointe';
  }

  return null;
}

function buildDevModeRequiredReply(reason = 'executer cette action') {
  return `J'ai besoin du mode DEV active pour ${reason}. Active-le en haut de l'ecran puis renvoie ta demande.`;
}

function shouldAutoUseUserActionAgent(body) {
  return !!detectDevModeRequiredReason(body);
}

function detectInternetResearchReason(body) {
  const latestUserMessage = getLatestUserMessage(body || {});
  const text = String(latestUserMessage || '').trim().toLowerCase();
  if (!text) return null;

  const hasUrl = /https?:\/\/\S+/i.test(text);
  const asksConsultUrl = hasUrl && /(analyse|ouvre|lis|resume|résume|explique|consulte|verifie|vérifie|inspecte|regarde)/i.test(text);
  const mentionsInternet = /(internet|web|site|page|article|actualite|actualité|actu|news|google|en ligne)/i.test(text);
  const asksSearch = /(cherche|recherche|trouve|regarde|consulte|compare|verifie|vérifie|check|liste|resume|résume|explique)/i.test(text);
  const asksCurrentInfo = /(aujourd'hui|today|actuellement|en ce moment|maintenant|dernier|derniere|dernière|latest|recent|récent|récente|meteo|météo|prix|cours|score|resultat|résultat|horaire|programme|trafic|tendance|actualite|actualité|actu|news|version actuelle|derniere version|dernière version|latest version|date de sortie|sortie recente|sortie récente)/i.test(text);
  const asksQuestion = /^(qui|que|quoi|quand|quel|quelle|quels|quelles|combien|ou|où|comment|donne|montre|dis|liste|compare|resume|résume|cherche|recherche|trouve)\b/i.test(text) || /\?$/.test(text);

  if (asksConsultUrl) return 'consulter une page web';
  if (mentionsInternet && asksSearch) return 'chercher sur internet';
  if (asksCurrentInfo && (asksQuestion || asksSearch)) return 'recuperer une information actuelle';
  return null;
}

function shouldAutoUseInternetAgent(body) {
  return !!detectInternetResearchReason(body);
}

function buildQflushMessagesWithMemory(storedMessages, logicalMemory, structuredMemoryContext, conversationResourceContext, systemPrompt) {
  return buildChatMessagesWithMemory(
    Array.isArray(storedMessages) ? storedMessages : [],
    logicalMemory,
    structuredMemoryContext,
    conversationResourceContext,
    systemPrompt
  );
}

async function proxyQflushChat(req, res) {
  const qflushChatFlow = getQflushChatFlow();
  if (!qflushChatFlow) {
    return res.status(500).json({
      ok: false,
      error: 'missing_qflush_chat_flow',
      message: 'QFLUSH chat mode requires QFLUSH_CHAT_FLOW to be configured.'
    });
  }

  try {
    const body = req.body || {};
    const userId = String(req.user?.id || body._user || '').trim();
    const latestUserMessage = getLatestUserMessage(body);
    const conversationId = normalizeConversationId(body.conversationId || body.convId || body.sessionId);

    const memoryContext = await loadUserMemoryContext(userId, latestUserMessage, conversationId);
    const {
      storedMessages,
      logicalMemory,
      structuredFacts,
      structuredTasks,
      structuredFiles,
      conversationResources,
      conversationResourceContext,
      structuredMemoryContext,
    } = memoryContext;

    const prompt = latestUserMessage || buildPromptFromMessages(storedMessages);
    const qflushMessages = buildQflushMessagesWithMemory(
      storedMessages,
      logicalMemory,
      structuredMemoryContext,
      conversationResourceContext,
      body.systemPrompt
    );

    console.log('[A11] USING QFLUSH flow ->', qflushChatFlow);
    const qflushResult = await runQflushFlow(qflushChatFlow, {
      prompt,
      messages: qflushMessages,
      model: body.model,
      systemPrompt: body.systemPrompt,
      logicalMemory,
      structuredMemory: {
        facts: structuredFacts,
        tasks: structuredTasks,
        files: structuredFiles,
        contextOnly: true,
      },
      chatHistoryLimit: CHAT_MEMORY_LIMIT,
      userId: userId || null,
      user: req.user || null,
      request: body
    });

    const rawContent = extractAssistantText(qflushResult);
    const resolvedAssistant = await resolveAssistantActionEnvelope({
      content: rawContent,
      allowDevActions: req.body?.a11Dev === true,
      conversationId,
      userId,
      requestOrigin: getRequestOrigin(req),
      executionContext: {
        authToken: getAuthTokenFromRequest(req),
      },
      messages: Array.isArray(body.messages) ? body.messages : [],
    });
    const content = resolvedAssistant.content;
    if (userId && content) {
      await saveChatMemoryMessage(userId, 'assistant', content, conversationId);
    }

    const data = {
      id: `chatcmpl-qflush-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'qflush',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
      memory: {
        userId: userId || null,
        historyCount: storedMessages.length,
        logicalSummary: logicalMemory || null,
        factsCount: structuredFacts.length,
        tasksCount: structuredTasks.length,
        filesCount: structuredFiles.length,
        conversationResourcesCount: conversationResources.length,
        historyLimit: CHAT_MEMORY_LIMIT,
      },
      qflush: qflushResult,
    };
    if (resolvedAssistant.extras) {
      data.a11Agent = resolvedAssistant.extras;
    }

    appendChatTurnLogSafe(body, data, 'qflush', userId);
    return res.status(200).json(data);
  } catch (err) {
    console.error('[A11] Error proxying chat via QFLUSH:', err && (err.message || err.toString()));
    return res.status(502).json({ ok: false, error: 'qflush_unreachable', message: String(err?.message) });
  }
}

async function proxyLocalLlamaCompletion(req, res, localLlamaCompletionUrl, bodyOverride = null) {
  try {
    const body = bodyOverride || req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userId = String(req.user?.id || body._user || '').trim();
    const conversationId = normalizeConversationId(body.conversationId || body.convId || body.sessionId);
    const prompt = typeof body.prompt === 'string' && body.prompt.trim()
      ? body.prompt
      : buildPromptFromMessages(messages);
    const nPredictRaw = body.n_predict ?? body.max_tokens ?? 200;
    const nPredict = Number.isFinite(Number(nPredictRaw)) ? Number(nPredictRaw) : 200;

    const userInfo = req.user?.username ? `(user: ${req.user.username})` : '';
    console.log('[A11][Llama] Proxying local completion', userInfo, '->', localLlamaCompletionUrl);
    const upstreamRes = await axios({
      method: 'post',
      url: localLlamaCompletionUrl,
      headers: { 'content-type': 'application/json' },
      data: {
        prompt,
        n_predict: nPredict,
        stream: false
      },
      timeout: 60000,
    });

    const rawContent = extractLocalCompletionContent(upstreamRes.data);
    const resolvedAssistant = await resolveAssistantActionEnvelope({
      content: rawContent,
      allowDevActions: body?.a11Dev === true,
      conversationId,
      userId,
      requestOrigin: getRequestOrigin(req),
      executionContext: {
        authToken: getAuthTokenFromRequest(req),
      },
      messages: Array.isArray(body.messages) ? body.messages : [],
    });
    const content = resolvedAssistant.content;
    const data = {
      id: `chatcmpl-local-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'local-gguf',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
    };
    if (resolvedAssistant.extras) {
      data.a11Agent = resolvedAssistant.extras;
    }

    if (userId && content) {
      await saveChatMemoryMessage(userId, 'assistant', content, conversationId);
    }

    appendChatTurnLogSafe(body, data, 'local-gguf', userId);
    return res.status(200).json(data);
  } catch (err) {
    console.error('[A11] Error proxying local llama.cpp completion ->', localLlamaCompletionUrl, err && (err.message || err.toString()));
    if (err.response?.data) {
      return res.status(err.response.status || 502).json(err.response.data);
    }
    return res.status(502).json({ ok: false, error: 'upstream_unreachable', message: String(err?.message) });
  }
}

async function proxyChatToOpenAI(req, res) {
  const provider = String(req.body?.provider || '').trim().toLowerCase();
  const latestUserMessage = getLatestUserMessage(req.body || {});
  const userId = String(req.user?.id || req.body?._user || '').trim();
  const conversationId = normalizeConversationId(req.body?.conversationId || req.body?.convId || req.body?.sessionId);

  if (isSiwisStatusQuestion(latestUserMessage)) {
    try {
      const snapshot = await getSiwisHealthSnapshot();
      const reply = formatSiwisStatusReply(snapshot);
      const data = toSimpleAssistantCompletion(reply, 'a11-runtime-tts-health');
      appendChatTurnLogSafe(req.body, data, 'a11-runtime-tts-health', userId);
      return res.status(200).json(data);
    } catch {
      const fallback = toSimpleAssistantCompletion('Je ne peux pas verifier SIWIS pour le moment (health timeout).');
      appendChatTurnLogSafe(req.body, fallback, 'a11-runtime-tts-health', userId);
      return res.status(200).json(fallback);
    }
  }

  if (shouldAutoUseUserActionAgent(req.body)) {
    const content = buildDevModeRequiredReply(detectDevModeRequiredReason(req.body) || 'executer cette action');
    const data = toSimpleAssistantCompletion(content, 'a11-dev-required');
    if (userId && content) {
      await saveChatMemoryMessage(userId, 'assistant', content, conversationId);
    }
    appendChatTurnLogSafe(req.body, data, 'a11-dev-required', userId);
    return res.status(200).json(data);
  }

  if (shouldAutoUseInternetAgent(req.body)) {
    const requestMessages = buildRequestMessagesFromBody(req.body);
    let internetMessages = requestMessages;

    if (userId) {
      const memoryContext = await loadUserMemoryContext(userId, latestUserMessage, conversationId);
      internetMessages = buildChatMessagesWithMemory(
        requestMessages,
        memoryContext.logicalMemory,
        memoryContext.structuredMemoryContext,
        memoryContext.conversationResourceContext,
        req.body?.systemPrompt
      );
    }

    const loopResult = await runA11AgentLoop({
      messages: internetMessages,
      conversationId,
      userId,
      requestOrigin: getRequestOrigin(req),
      executionContext: {
        authToken: getAuthTokenFromRequest(req),
      },
      allowedActions: INTERNET_SAFE_AGENT_ACTIONS,
      maxLoops: 4,
    });

    const content = normalizeAssistantOutput(
      loopResult.explanation
      || loopResult.text
      || `Je n'ai pas pu ${detectInternetResearchReason(req.body) || 'consulter internet'}.`
    );
    const data = toSimpleAssistantCompletion(content, 'a11-web');
    if (loopResult.imagePath || loopResult.cerbere) {
      data.a11Agent = {
        imagePath: loopResult.imagePath || null,
        ...(loopResult.cerbere ? { results: loopResult.cerbere.results } : {}),
      };
    }
    if (userId && content) {
      await saveChatMemoryMessage(userId, 'assistant', content, conversationId);
    }
    appendChatTurnLogSafe(req.body, data, 'a11-web', userId);
    return res.status(200).json(data);
  }

  if (shouldUseQflushChat(req.body)) {
    return proxyQflushChat(req, res);
  }

  let upstreamBody = req.body ? { ...req.body } : {};

  if (userId) {
    const memoryContext = await loadUserMemoryContext(userId, latestUserMessage, conversationId);
    const requestMessages = buildRequestMessagesFromBody(req.body);
    upstreamBody.messages = buildChatMessagesWithMemory(
      requestMessages,
      memoryContext.logicalMemory,
      memoryContext.structuredMemoryContext,
      memoryContext.conversationResourceContext,
      req.body?.systemPrompt
    );

    if ((!upstreamBody.prompt || !String(upstreamBody.prompt).trim()) && upstreamBody.messages.length) {
      upstreamBody.prompt = buildPromptFromMessages(upstreamBody.messages);
    }
  }

  const localLlamaCompletionUrl = provider === 'local' ? getLocalLlamaCompletionUrl() : null;

  if (localLlamaCompletionUrl) {
    console.log('[A11] USING LOCAL_LLM_URL ->', localLlamaCompletionUrl);
    return proxyLocalLlamaCompletion(req, res, localLlamaCompletionUrl, upstreamBody);
  }

  const upstreamUrl = getCompletionsUrlForRequest(req.body);
  if (!upstreamUrl) {
    return res.status(500).json({
      ok: false,
      error: 'missing_local_upstream',
      message: 'provider=local requires LOCAL_LLM_URL or LLAMA_BASE, or enable QFLUSH chat with QFLUSH_CHAT_FLOW.'
    });
  }

  if (provider !== 'local' && isRecursiveOpenAIUpstream(req, upstreamUrl)) {
    console.error('[A11] Recursive OPENAI_BASE_URL detected:', upstreamUrl);
    return res.status(503).json({
      ok: false,
      error: 'recursive_openai_base_url',
      message: 'OPENAI_BASE_URL points to this same A11 API. Configure a real upstream LLM base URL such as https://api.openai.com/v1, or use LOCAL_LLM_URL/LLAMA_BASE/QFLUSH instead.',
      upstreamUrl,
    });
  }
  console.log('[A11] USING', provider === 'local' ? 'LLAMA_BASE' : 'OPENAI', '->', upstreamUrl);

  try {
    const upstreamRes = await axios({
      method: 'post',
      url: upstreamUrl,
      headers: buildOpenAIProxyHeaders(req.headers, { provider }),
      data: upstreamBody && Object.keys(upstreamBody).length ? upstreamBody : undefined,
      timeout: 60000,
    });

    const data = upstreamRes.data;
    const rawContent = extractAssistantText(data);
    const resolvedAssistant = await resolveAssistantActionEnvelope({
      content: rawContent,
      allowDevActions: req.body?.a11Dev === true,
      conversationId,
      userId,
      requestOrigin: getRequestOrigin(req),
      executionContext: {
        authToken: getAuthTokenFromRequest(req),
      },
      messages: Array.isArray(req.body?.messages) ? req.body.messages : [],
    });
    const content = resolvedAssistant.content;
    applyAssistantTextToPayload(data, content, resolvedAssistant.extras);
    if (userId && content) {
      await saveChatMemoryMessage(userId, 'assistant', content, conversationId);
    }

    appendChatTurnLogSafe(req.body, data, 'gpt-4o-mini', userId);

    return res.status(upstreamRes.status).json(data);
  } catch (err) {
    const localFallbackUrl = getLocalLlamaCompletionUrl();
    if (provider !== 'local' && localFallbackUrl && shouldFallbackToLocalOnOpenAIError(err)) {
      console.warn('[A11] OpenAI unavailable, falling back to LOCAL_LLM_URL ->', localFallbackUrl);
      return proxyLocalLlamaCompletion(
        req,
        res,
        localFallbackUrl,
        {
          ...upstreamBody,
          provider: 'local',
          model: String(process.env.LOCAL_DEFAULT_MODEL || upstreamBody?.model || 'llama3.2:latest'),
        }
      );
    }

    console.error('[A11] Error proxying chat ->', upstreamUrl, err && (err.message || err.toString()));
    if (err.response?.data) {
      return res.status(err.response.status || 502).json(err.response.data);
    }
    return res.status(502).json({ ok: false, error: 'upstream_unreachable', message: String(err?.message) });
  }
}

// Canonical OpenAI-like route
app.post('/v1/chat/completions', proxyChatToOpenAI);

// Existing frontend route
app.post('/api/llm/chat', proxyChatToOpenAI);

// Compatibility aliases used by older frontend builds — ensure provider defaults to 'local' if available
app.post('/api/ai', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body) req.body = {};
    if (!req.body.provider && (process.env.LOCAL_LLM_URL?.trim() || process.env.LLAMA_BASE?.trim() || getQflushChatFlow())) {
      req.body.provider = 'local';
    }
    return proxyChatToOpenAI(req, res);
  } catch (err) {
    console.error('[A11][/api/ai] Error:', err?.message);
    return res.status(502).json({ ok: false, error: 'proxy_error', message: String(err?.message) });
  }
});

app.post('/api/completions', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    if (!req.body) req.body = {};
    if (!req.body.provider && (process.env.LOCAL_LLM_URL?.trim() || process.env.LLAMA_BASE?.trim() || getQflushChatFlow())) {
      req.body.provider = 'local';
    }
    return proxyChatToOpenAI(req, res);
  } catch (err) {
    console.error('[A11][/api/completions] Error:', err?.message);
    return res.status(502).json({ ok: false, error: 'proxy_error', message: String(err?.message) });
  }
});

// helper to collect stream into buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', (e) => reject(e));
  });
}

// Global runtime flags and port (single source of truth)
let LISTENING = false;
if (globalThis.__A11_PORT === undefined) {
  globalThis.__A11_PORT = Number(process.env.PORT) || 3000;
}
const PORT = globalThis.__A11_PORT;
console.log(`[A11] PORT utilisé: ${ PORT } (source: ${ envSource }, env: ${ process.env.PORT || 'non défini'})`);

// Single DEFAULT_UPSTREAM: prefer LLAMA_BASE if set, otherwise use localhost (11434)
if (globalThis.__A11_DEFAULT_UPSTREAM === undefined) {
  const host = '127.0.0.1';
  // default to llama-server port 8080 when LLAMA_BASE is not set
  const port = process.env.LLAMA_PORT || process.env.LOCAL_LLM_PORT || '8080';
  const configuredLlmBase = process.env.LLAMA_BASE?.trim();
  // If a local LLM router is configured, prefer it as the default upstream
  if (process.env.LLM_ROUTER_URL?.trim()) {
    globalThis.__A11_DEFAULT_UPSTREAM = process.env.LLM_ROUTER_URL.trim();
    console.log('[Alpha Onze] Using LLM router as DEFAULT_UPSTREAM =', globalThis.__A11_DEFAULT_UPSTREAM);
  } else {
    globalThis.__A11_DEFAULT_UPSTREAM = configuredLlmBase || `http://${host}:${port}`;
  }
}
const DEFAULT_UPSTREAM = globalThis.__A11_DEFAULT_UPSTREAM;

// Determine backend mode from environment. Defaults to 'local' for LLaMA usage.
// Expose configured backend and LLAMA_BASE for diagnostics.
const LLAMA_BASE_ENV = process.env.LLAMA_BASE?.trim();
const RAW_BACKEND = String(process.env.BACKEND || '').trim().toLowerCase();
const BACKEND = (LLAMA_BASE_ENV ? 'local' : (RAW_BACKEND || 'local'));
if (LLAMA_BASE_ENV && RAW_BACKEND !== 'local') {
    console.log(`[Alpha Onze] Notice: LLAMA_BASE is set -> forcing BACKEND='local' (was '${RAW_BACKEND || 'unset'}').`);
}

// Intégration automatique des modules power1, power2, power3
let power1, power2, power3;
try {
  power1 = require('./dist/a11/power1');
} catch (e) {
  console.warn('[A11] power1 non chargé:', e?.message);
}
try {
  power2 = require('./dist/a11/power2');
} catch (e) {
  console.warn('[A11] power2 non chargé:', e?.message);
}
try {
  power3 = require('./dist/a11/power3');
} catch (e) {
  console.warn('[A11] power3 non chargé:', e?.message);
}
globalThis.power1 = power1;
globalThis.power2 = power2;
globalThis.power3 = power3;

// Ajout des routes pour le pont QFlush et l'agent A-11
const { runQflushTool } = require("./lib/qflushTools");
const { callA11AgentLLM } = require("./lib/a11Agent"); // à créer ou adapter

app.use(express.json());

app.get('/api/qflush/status', (req, res) => {
  if (!QFLUSH_AVAILABLE) {
    return res.json({ available: false, message: 'QFlush not available' });
  }

  try {
    const supervisor = globalThis.__A11_QFLUSH_SUPERVISOR || globalThis.__A11_SUPERVISOR;
    if (!supervisor) {
      return res.json({
        available: true,
        initialized: false,
        remoteUrl: process.env.QFLUSH_REMOTE_URL || process.env.QFLUSH_URL || null,
        chatFlow: getQflushChatFlow() || null,
        memorySummaryFlow: getQflushMemorySummaryFlow(),
        memorySummaryBuiltIn: isBuiltInMemorySummaryFlow(getQflushMemorySummaryFlow()),
        message: 'Supervisor not initialized'
      });
    }

    const status = qflushIntegration.getStatus(supervisor);
    return res.json({
      available: true,
      initialized: true,
      remoteUrl: process.env.QFLUSH_REMOTE_URL || process.env.QFLUSH_URL || null,
      chatFlow: getQflushChatFlow() || null,
      memorySummaryFlow: getQflushMemorySummaryFlow(),
      memorySummaryBuiltIn: isBuiltInMemorySummaryFlow(getQflushMemorySummaryFlow()),
      ...status
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/tools/run", async (req, res) => {
  try {
    const { tool, input } = req.body || {};
    if (!tool) {
      return res.status(400).json({ ok: false, error: "Missing 'tool' field" });
    }
    const result = await runQflushTool(tool, input || {});
    res.json(result);
  } catch ( e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Nouveau endpoint IA avec Qflush
app.post('/ai', async (req, res) => {
  try {
    const { input, mode, flow } = req.body || {};
    if (!input) {
      return res.status(400).json({ error: 'Missing input' });
    }

    let output;
    if (mode === 'qflush') {
      const effectiveFlow = String(flow || getQflushChatFlow() || '').trim();
      if (!effectiveFlow) {
        return res.status(500).json({
          error: 'Missing QFLUSH flow',
          message: 'Set QFLUSH_CHAT_FLOW or pass { mode: "qflush", flow: "..." }.'
        });
      }
      const result = await runQflushFlow(effectiveFlow, { input, prompt: input, request: req.body || {} });
      output = extractAssistantText(result) || JSON.stringify(result);
    } else {
      // Mode LLM : proxy vers le LLM router
      const upstreamHost = process.env.LLM_ROUTER_URL?.trim() || DEFAULT_UPSTREAM;
      const upstreamUrl = String(upstreamHost).replace(/\/$/, '') + '/v1/chat/completions';

      const upstreamRes = await axios.post(upstreamUrl, {
        model: 'llama3.2:latest',
        messages: [{ role: 'user', content: input }],
        stream: false
      }, { timeout: 60000 });

      output = upstreamRes.data.choices?.[0]?.message?.content || 'Réponse LLM vide';
    }

    res.json({ output });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const { A11_AGENT_SYSTEM_PROMPT, A11_AGENT_DEV_PROMPT } = require('./lib/a11Agent.js');
const { runAction, runActionsEnvelope, getAllowedActionNames } = require('./src/a11/tools-dispatcher.cjs');

function buildA11AgentInjectedContext(messages, toolResults = [], options = {}) {
  const compactMode = options.compact === true;
  const maxMessages = compactMode ? 6 : 10;
  const maxCharsPerMessage = compactMode ? 420 : 700;
  const maxTotalChars = compactMode ? 2200 : 4200;
  const maxToolResults = compactMode ? 3 : 6;
  const workspaceRoot = String(
    process.env.A11_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT || path.resolve(__dirname, '..', '..')
  ).trim();
  const temporalContext = buildTemporalContextBlock(messages);
  const restrictedActions = Array.isArray(options.allowedActions)
    ? options.allowedActions.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const allowedActions = restrictedActions.length
    ? [...new Set(restrictedActions)]
    : getAllowedActionNames();
  const userPrompt = buildA11AgentConversationExcerpt(messages, {
    maxMessages,
    maxCharsPerMessage,
    maxTotalChars,
  });
  const latestUserRequest = getLatestUserMessageFromMessages(messages) || buildPromptFromMessages(Array.isArray(messages) ? messages : []);
  const compactToolResults = buildA11AgentToolResultsSnapshot(toolResults, maxToolResults);
  return [
    '[TOOLS]',
    `AllowedActions=${JSON.stringify(allowedActions)}`,
    `ActionPolicy=${restrictedActions.length ? 'user-safe-only' : 'full'}`,
    '',
    '[TIME]',
    temporalContext,
    '',
    '[CONTEXT]',
    `workspaceRoot=${workspaceRoot}`,
    '',
    '[LATEST_USER_REQUEST]',
    truncateA11AgentText(latestUserRequest, compactMode ? 900 : 1400),
    '',
    '[RECENT_CHAT]',
    userPrompt,
    '',
    '[TOOL_RESULTS]',
    JSON.stringify(compactToolResults, null, 2),
  ].join('\n');
}

function truncateA11AgentText(value, maxChars = 800) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function compactA11AgentValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return truncateA11AgentText(value, depth === 0 ? 500 : 220);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, depth === 0 ? 5 : 3).map((entry) => compactA11AgentValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const compact = {};
    const blockedKeys = new Set(['stack', 'raw', 'buffer', 'contentBase64', 'html', 'content', 'markdown', 'text']);
    for (const [key, nested] of Object.entries(value).slice(0, 12)) {
      if (blockedKeys.has(key)) continue;
      compact[key] = compactA11AgentValue(nested, depth + 1);
    }
    return compact;
  }
  return String(value);
}

function buildA11AgentToolResultsSnapshot(toolResults = [], maxResults = 6) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  return list.slice(-maxResults).map((entry) => ({
    action: String(entry?.action || entry?.tool || entry?.name || '').trim() || undefined,
    ok: entry?.ok === true,
    error: entry?.ok === false ? truncateA11AgentText(entry?.error || entry?.result?.error || '', 220) || undefined : undefined,
    result: compactA11AgentValue(entry?.result && typeof entry.result === 'object' ? entry.result : {}),
  }));
}

function buildA11AgentConversationExcerpt(messages = [], options = {}) {
  const maxMessages = Math.max(1, Number(options.maxMessages || 8));
  const maxCharsPerMessage = Math.max(80, Number(options.maxCharsPerMessage || 600));
  const maxTotalChars = Math.max(400, Number(options.maxTotalChars || 3600));
  const list = Array.isArray(messages) ? messages : [];
  const excerptLines = [];
  let totalChars = 0;

  for (const message of list.slice(-maxMessages)) {
    const role = normalizeChatRole(message?.role);
    if (!role) continue;
    const content = truncateA11AgentText(message?.content || '', maxCharsPerMessage);
    if (!content) continue;
    const ts = normalizeChatTimestamp(message?.ts);
    const prefix = ts ? `${role}@${ts}: ` : `${role}: `;
    const line = `${prefix}${content}`;
    if (totalChars + line.length > maxTotalChars) break;
    excerptLines.push(line);
    totalChars += line.length + 1;
  }

  return excerptLines.join('\n') || '(chat vide)';
}

function isA11ContextSizeErrorMessage(message = '') {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('exceed_context_size_error')
    || normalized.includes('exceeds the available context size')
    || (normalized.includes('context size') && normalized.includes('n_ctx'));
}

async function callA11LLMAttempt(messages, options = {}) {
  const injectedContext = buildA11AgentInjectedContext(messages, options.toolResults, {
    allowedActions: options.allowedActions,
    compact: options.compact,
  });
  const promptMessages = [
    { role: 'system', content: A11_AGENT_SYSTEM_PROMPT },
    { role: 'system', content: A11_AGENT_DEV_PROMPT },
    { role: 'user', content: injectedContext }
  ];
  const body = {
    model: 'llama3.2:latest',
    messages: promptMessages,
    stream: false
  };
  const localChatUrl = getLocalCompletionsUrl();
  if (localChatUrl) {
    const res = await fetch(localChatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`A11 LLM error: ${res.status} – ${await res.text()}`);
    const data = await res.json();
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.delta?.content ??
      extractAssistantText(data) ??
      '';
    return String(content || '').trim();
  }

  const localCompletionUrl = getLocalLlamaCompletionUrl();
  if (localCompletionUrl) {
    const prompt = buildPromptFromMessages(promptMessages);
    const upstreamRes = await axios({
      method: 'post',
      url: localCompletionUrl,
      headers: { 'content-type': 'application/json' },
      data: {
        prompt,
        n_predict: Number(process.env.A11_AGENT_MAX_TOKENS || 700),
        stream: false
      },
      timeout: 60000,
    });
    return extractLocalCompletionContent(upstreamRes.data).trim();
  }

  return normalizeAssistantOutput(await callChatBackend(promptMessages, {
    provider: getMemorySummaryProvider(),
    model: process.env.A11_AGENT_MODEL || process.env.MEMORY_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  }));
}

async function callA11LLM(messages, options = {}) {
  try {
    return await callA11LLMAttempt(messages, { ...options, compact: false });
  } catch (error) {
    if (!isA11ContextSizeErrorMessage(error?.message || error)) {
      throw error;
    }
    return callA11LLMAttempt(messages, { ...options, compact: true });
  }
}

function buildInternetFallbackEnvelope(messages, { conversationId, userId, allowedActions = [], latestOutput = '' } = {}) {
  const allowedSet = new Set(
    (Array.isArray(allowedActions) ? allowedActions : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  );
  const canSearch = !allowedSet.size || allowedSet.has('web_search');
  const canFetch = !allowedSet.size || allowedSet.has('web_fetch');
  if (!canSearch && !canFetch) return null;

  const latestUserMessage = stripDevEnginePrefix(getLatestUserMessageFromMessages(messages));
  if (!latestUserMessage) return null;

  const researchReason = detectInternetResearchReason({
    messages: [{ role: 'user', content: latestUserMessage }],
    prompt: latestUserMessage,
  });
  const normalizedOutput = String(latestOutput || '').toLowerCase();
  const modelRefusedInternet = /(pas acces|pas d'acces|pas d’accès|ne peux pas acceder|ne peux pas consulter|no internet access|can't access|cannot access).*(internet|web|site|page)/i.test(normalizedOutput);
  if (!researchReason && !modelRefusedInternet) {
    return null;
  }

  const urlMatch = latestUserMessage.match(/https?:\/\/\S+/i);
  if (urlMatch && canFetch) {
    return {
      version: 'a11-envelope-1',
      mode: 'actions',
      conversationId,
      userId,
      actions: [
        {
          name: 'web_fetch',
          id: 'wf-1',
          arguments: {
            url: urlMatch[0],
          },
        },
      ],
    };
  }

  if (!canSearch) return null;
  return {
    version: 'a11-envelope-1',
    mode: 'actions',
    conversationId,
    userId,
    actions: [
      {
        name: 'web_search',
        id: 'ws-1',
        arguments: {
          query: latestUserMessage,
          limit: 5,
        },
      },
    ],
  };
}

// --- Helpers Cerbère -> A-11 ---
function summarizeCerbereResults(cerbere) {
  try {
    if (!cerbere) return 'Actions exécutées par Cerbère.';
    let actions = [];
    if (Array.isArray(cerbere.results)) {
      actions = cerbere.results;
    } else if (Array.isArray(cerbere.actions)) {
      actions = cerbere.actions;
    }
    const parts = actions.map((a) => {
      const ok = a?.result?.ok ?? a?.ok;
      const tool = a?.name || a?.tool || a?.action || 'action';
      const result = a?.result || {};
      const outputPath = String(result.outputPath || result.path || result.filePath || '').trim();
      const label = outputPath ? path.basename(outputPath) : '';
      if (!ok) {
        return `• ${tool} → erreur${a?.error ? ` (${a.error})` : ''}`;
      }
      if (tool === 'generate_png') {
        return `• Image générée${label ? ` (${label})` : ''}`;
      }
      if (tool === 'generate_pdf') {
        return `• PDF généré${label ? ` (${label})` : ''}`;
      }
      if (tool === 'download_file') {
        return `• Fichier téléchargé${label ? ` (${label})` : ''}`;
      }
      if (tool === 'write_file') {
        return `• Fichier écrit${label ? ` (${label})` : ''}`;
      }
      if (tool === 'share_file') {
        const fileLabel = result?.file?.filename || label;
        const mailedTo = Array.isArray(result?.mail?.to)
          ? result.mail.to.join(', ')
          : String(result?.mail?.to || result?.mail?.emailTo || '').trim();
        return `• Fichier partagé${fileLabel ? ` (${fileLabel})` : ''}${mailedTo ? ` et envoyé à ${mailedTo}` : ''}`;
      }
      if (tool === 'send_email') {
        const mailedTo = Array.isArray(result?.to)
          ? result.to.join(', ')
          : Array.isArray(result?.mail?.to)
            ? result.mail.to.join(', ')
            : String(result?.to || result?.mail?.to || '').trim();
        return `• Email envoyé${mailedTo ? ` à ${mailedTo}` : ''}`;
      }
      if (tool === 'list_stored_files') {
        const count = Number(result?.count || (Array.isArray(result?.files) ? result.files.length : 0));
        return `• ${count} fichier(s) stocké(s) listé(s)`;
      }
      if (tool === 'list_resources') {
        const count = Number(result?.count || (Array.isArray(result?.resources) ? result.resources.length : 0));
        return `• ${count} ressource(s) listée(s)`;
      }
      if (tool === 'get_latest_resource') {
        const labelResource = result?.resource?.filename ? ` (${result.resource.filename})` : '';
        return `• Dernière ressource trouvée${labelResource}`;
      }
      if (tool === 'email_resource') {
        const mailedTo = Array.isArray(result?.to)
          ? result.to.join(', ')
          : String(result?.to || result?.mail?.to || '').trim();
        const labelResource = result?.resource?.filename ? ` (${result.resource.filename})` : '';
        return `• Ressource envoyée${labelResource}${mailedTo ? ` à ${mailedTo}` : ''}`;
      }
      if (tool === 'email_latest_resource') {
        const mailedTo = Array.isArray(result?.to)
          ? result.to.join(', ')
          : String(result?.to || result?.mail?.to || '').trim();
        const labelResource = result?.resource?.filename ? ` (${result.resource.filename})` : '';
        return `• Dernière ressource envoyée${labelResource}${mailedTo ? ` à ${mailedTo}` : ''}`;
      }
      if (tool === 'schedule_email' || tool === 'schedule_resource_email' || tool === 'schedule_latest_resource_email') {
        const sendAt = String(result?.job?.sendAt || '').trim();
        return `• Email planifié${sendAt ? ` pour ${sendAt}` : ''}`;
      }
      if (tool === 'list_scheduled_emails') {
        const count = Number(result?.count || (Array.isArray(result?.jobs) ? result.jobs.length : 0));
        return `• ${count} email(s) planifié(s) listé(s)`;
      }
      if (tool === 'cancel_scheduled_email') {
        return `• Email planifié annulé`;
      }
      if (tool === 'zip_and_email') {
        const labelZip = result?.zip?.outputPath ? ` (${path.basename(result.zip.outputPath)})` : '';
        return `• Archive ZIP créée et envoyée${labelZip}`;
      }
      return `• ${tool} → ok`;
    });
    if (!parts.length) return 'Actions exécutées par Cerbère.';
    return ['Actions exécutées par Cerbère :', ...parts].join('\n');
  } catch {
    return 'Actions exécutées par Cerbère.';
  }
}

function getPublicFilesBaseUrl(requestOrigin = '') {
  const explicitPublicApi = String(process.env.PUBLIC_API_URL || process.env.API_URL || '').trim();
  if (explicitPublicApi) {
    try {
      return new URL(explicitPublicApi).origin;
    } catch {
      // ignore malformed config and keep falling back
    }
  }

  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  return String(requestOrigin || '').trim();
}

function toPublicWorkspaceFileUrl(candidatePath, requestOrigin = '') {
  const raw = String(candidatePath || '').trim();
  if (!raw) return null;
  const absolutePath = path.isAbsolute(raw) ? raw : path.resolve(WORKSPACE_ROOT, raw);
  const relativePath = path.relative(WORKSPACE_ROOT, absolutePath).replaceAll('\\', '/');
  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }
  const encodedRelativePath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const publicPath = `/files/${encodedRelativePath}`;
  const baseUrl = getPublicFilesBaseUrl(requestOrigin);
  return baseUrl ? `${baseUrl}${publicPath}` : publicPath;
}

function extractImagePathFromCerbere(cerbere, requestOrigin = '') {
  let actions = [];
  if (Array.isArray(cerbere?.results)) {
    actions = cerbere.results;
  } else if (Array.isArray(cerbere?.actions)) {
    actions = cerbere.actions;
  }
  for (const a of actions) {
    const tool = a?.name || a?.tool || a?.action;
    const r = a?.result || {};
    const p = r.outputPath || r.path || r.savedAs || r.filePath;
    if (r?.ok === false) {
      continue;
    }
    if ((tool === 'download_file' || tool === 'generate_png' || tool === 'generate_image') && typeof p === 'string' && p.length > 0) {
      return toPublicWorkspaceFileUrl(p, requestOrigin) || p;
    }
  }
  return null;
}

async function runA11AgentLoop({
  messages,
  conversationId,
  userId,
  requestOrigin = '',
  executionContext = null,
  allowedActions = null,
  maxLoops = 5,
}) {
  const aggregatedActions = [];
  const aggregatedResults = [];
  let toolResults = [];
  let latestOutput = '';
  let imagePath = null;
  const actionExecutionContext = allowedActions?.length
    ? { ...(executionContext || {}), allowedActions, conversationId, userId }
    : { ...(executionContext || {}), conversationId, userId };

  for (let loopIndex = 0; loopIndex < maxLoops; loopIndex += 1) {
    latestOutput = await callA11LLM(messages, { toolResults, allowedActions });
    let envelope = parseAssistantEnvelope(latestOutput, { conversationId, userId });

    if (!envelope && !aggregatedResults.length) {
      envelope = buildInternetFallbackEnvelope(messages, {
        conversationId,
        userId,
        allowedActions,
        latestOutput,
      });
    }

    if (!envelope) {
      const text = normalizeAssistantOutput(latestOutput);
      if (!aggregatedResults.length) {
        return {
          ok: true,
          mode: 'text',
          explanation: text,
          text,
          imagePath,
          cerbere: null,
          envelope: null,
        };
      }
      const generatedReply = await generateDevActionReply({
        messages,
        cerbere: { ok: true, results: aggregatedResults },
        imagePath,
      });
      return {
        ok: true,
        mode: 'dev',
        explanation: generatedReply,
        text: null,
        imagePath,
        cerbere: { ok: true, results: aggregatedResults },
        envelope: {
          version: 'a11-envelope-1',
          mode: 'actions',
          conversationId,
          userId,
          actions: aggregatedActions,
        },
      };
    }

    if (envelope.mode === 'final') {
      const text = normalizeAssistantOutput(envelope.answer || 'Termine.');
      if (!aggregatedResults.length) {
        const fallbackEnvelope = buildInternetFallbackEnvelope(messages, {
          conversationId,
          userId,
          allowedActions,
          latestOutput: text,
        });
        if (fallbackEnvelope) {
          envelope = fallbackEnvelope;
        }
      }
    }

    if (envelope.mode === 'final') {
      const text = normalizeAssistantOutput(envelope.answer || 'Termine.');
      if (!aggregatedResults.length) {
        return {
          ok: true,
          mode: 'text',
          explanation: text,
          text,
          imagePath,
          cerbere: null,
          envelope,
        };
      }
      const generatedReply = await generateDevActionReply({
        messages,
        cerbere: { ok: true, results: aggregatedResults },
        imagePath,
      });
      return {
        ok: true,
        mode: 'dev',
        explanation: generatedReply,
        text: null,
        imagePath,
        cerbere: { ok: true, results: aggregatedResults },
        envelope: {
          version: 'a11-envelope-1',
          mode: 'actions',
          conversationId,
          userId,
          actions: aggregatedActions,
        },
      };
    }

    if (envelope.mode === 'need_user') {
      const text = formatNeedUserEnvelope(envelope);
      if (!aggregatedResults.length) {
        return {
          ok: true,
          mode: 'text',
          explanation: text,
          text,
          imagePath,
          cerbere: null,
          envelope,
        };
      }
      return {
        ok: true,
        mode: 'dev',
        explanation: text,
        text: null,
        imagePath,
        cerbere: { ok: true, results: aggregatedResults },
        envelope: {
          version: 'a11-envelope-1',
          mode: 'actions',
          conversationId,
          userId,
          actions: aggregatedActions,
        },
      };
    }

    aggregatedActions.push(...(Array.isArray(envelope.actions) ? envelope.actions : []));
    const cerbere = await runActionsEnvelope(envelope, actionExecutionContext);
    const batchResults = Array.isArray(cerbere?.results) ? cerbere.results : [];
    aggregatedResults.push(...batchResults);
    toolResults = batchResults;

    const batchImagePath = extractImagePathFromCerbere(cerbere, requestOrigin);
    if (batchImagePath) {
      imagePath = batchImagePath;
    }

    if (!batchResults.length) {
      break;
    }
  }

  const combinedCerbere = aggregatedResults.length ? { ok: true, results: aggregatedResults } : null;
  const explanation = combinedCerbere
    ? await generateDevActionReply({ messages, cerbere: combinedCerbere, imagePath })
    : normalizeAssistantOutput(latestOutput);

  return {
    ok: true,
    mode: combinedCerbere ? 'dev' : 'text',
    explanation,
    text: combinedCerbere ? null : explanation,
    imagePath,
    cerbere: combinedCerbere,
    envelope: aggregatedActions.length
      ? {
          version: 'a11-envelope-1',
          mode: 'actions',
          conversationId,
          userId,
          actions: aggregatedActions,
        }
      : null,
  };
}

app.post('/api/agent', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const allowDevActions = body.allowDevActions === true || body.devMode === true;
    if (!allowDevActions) {
      return res.status(403).json({
        ok: false,
        error: 'dev_mode_required',
        message: buildDevModeRequiredReply(),
      });
    }

    const userId = String(req.user?.id || body.userId || '').trim();
    const conversationId = normalizeConversationId(body.conversationId || body.convId || body.sessionId);
    const executionContext = {
      authToken: getAuthTokenFromRequest(req),
    };

    let envelope = normalizeActionEnvelopeShape(body.envelope, {
      conversationId,
      userId,
    });

    if (!envelope && Array.isArray(body.messages) && body.messages.length > 0) {
      const loopResult = await runA11AgentLoop({
        messages: body.messages,
        conversationId,
        userId,
        requestOrigin: getRequestOrigin(req),
        executionContext,
      });
      return res.json({
        ok: true,
        mode: loopResult.mode,
        explanation: loopResult.explanation,
        text: loopResult.text,
        imagePath: loopResult.imagePath || null,
        cerbere: loopResult.cerbere,
        envelope: loopResult.envelope,
      });
    }

    if (!envelope) {
      return res.status(400).json({
        ok: false,
        error: 'Missing "envelope" in request body'
      });
    }

    const executed = await resolveAssistantActionEnvelope({
      content: JSON.stringify(envelope),
      allowDevActions: true,
      conversationId,
      userId,
      requestOrigin: getRequestOrigin(req),
      executionContext,
      messages: Array.isArray(body.messages) ? body.messages : [],
    });

    return res.json({
      ok: true,
      mode: 'dev',
      explanation: executed.content,
      imagePath: executed.extras?.imagePath || null,
      cerbere: executed.cerbere,
      envelope: executed.envelope,
    });
  } catch (e) {
    console.error('[A11][agent] error:', e);
    return res.status(500).json({
      ok: false,
      error: String(e?.message)
    });
  }
});

// ─────────────────────────────────────────────
// API: lecture de la mémoire des conversations
// ─────────────────────────────────────────────
app.get('/api/a11/memory/conversations', (req, res) => {
  try {
    ensureConvDir();

    // Si le dossier n'existe toujours pas → pas d'erreur, juste vide
    if (!fsMem.existsSync(A11_CONV_DIR)) {
      return res.json({ ok: true, entries: [] });
    }

    const files = fsMem
      .readdirSync(A11_CONV_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => d.name);

    const entries = [];

    for (const f of files) {
      const full = pathMem.join(A11_CONV_DIR, f);
      let raw;
      try {
        raw = fsMem.readFileSync(full, 'utf8');
      } catch (e) {
        console.warn('[A11][memory] read file failed:', full, e?.message);
        continue;
      }
      const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch (e) {
          console.warn('[A11][memory] JSON parse error in', full, e?.message);
        }
      }
    }

    entries.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    res.json({ ok: true, entries });
  } catch ( e) {
    console.error('[A11][memory] read failed:', e?.message);
    res.status(500).json({ ok: false, error: String(e?.message) });
  }
});
/// --- Fin API mémoire ---

// --- MEMO API: créer un mémo ---
app.post('/api/a11/memo', express.json(), (req, res) => {
  const { type, data } = req.body || {};

  if (!type || data === undefined) {
    return res.status(400).json({ ok: false, error: 'Missing type or data' });
  }

  const entry = saveMemo(type, data);
  if (!entry) {
    return res.status(500).json({ ok: false, error: 'Failed to save memo' });
  }

  return res.json({ ok: true, memo: entry });
});

// --- MEMO API: récupérer tous les mémos ---
app.get('/api/a11/memo/all', (req, res) => {
  const entries = loadAllMemos();
  return res.json({ ok: true, entries });
});

app.get('/api/a11/memo/summary', verifyJWT, (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ ok: false, error: 'admin_required' });
    }
    const entries = loadAllMemos();
    return res.json({ ok: true, summary: summarizeMemoEntries(entries) });
  } catch (e) {
    console.error('[A11][memo] summary failed:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message || 'memo_summary_failed' });
  }
});

// --- MEMO API: récupérer un mémo complet par ID ---
app.get('/api/a11/memo/:id', (req, res) => {
  const id = req.params.id;
  const file = path.join(A11_MEMO_DIR, `${id}.json`);

  if (!fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: 'Memo not found' });
  }

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const memo = JSON.parse(raw);
    return res.json({ ok: true, memo });
  } catch (e) {
    console.error('[A11][memo] read memo failed:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message });
  }
});

app.delete('/api/a11/memo', verifyJWT, (req, res) => {
  try {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ ok: false, error: 'admin_required' });
    }
    const result = purgeTechnicalMemos();
    return res.json(result);
  } catch (e) {
    console.error('[A11][memo] purge failed:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message || 'memo_purge_failed' });
  }
});

// --- MEMOS AUTO: snapshot au démarrage ---
function snapshotOnStartup() {
  try {
    const safeEnv = {};
    const keys = [
      'NODE_ENV',
      'BACKEND',
      'LLAMA_BASE',
      'LLAMA_PORT',
      'LLM_ROUTER_URL',
      'PORT',
      'HOST_SERVER'
    ];
    for (const k of keys) {
      if (process.env[k] !== undefined) safeEnv[k] = process.env[k];
    }

    const qflushInfo = {
      available: !!globalThis.__QFLUSH_AVAILABLE,
      module: !!globalThis.__QFLUSH_MODULE,
      exePath: globalThis.__QFLUSH_PATH || null
    };

    saveMemo('env_snapshot', {
      ts: Date.now(),
      env: safeEnv,
      qflush: qflushInfo
    });
    console.log('[A11][memo] env_snapshot saved on startup');
  } catch (e) {
    console.warn('[A11][memo] env_snapshot failed:', e?.message);
  }
}
snapshotOnStartup();

// Ajout de la route POST /api/a11/memo/snapshot/qflush pour snapshot QFlush à la demande dans server.cjs.
app.post('/api/a11/memo/snapshot/qflush', async (req, res) => {
  try {
    const info = {
      available: !!globalThis.__QFLUSH_AVAILABLE,
      exePath: globalThis.__QFLUSH_PATH || null,
      module: !!globalThis.__QFLUSH_MODULE
    };
    const entry = saveMemo('qflush_snapshot', info);
    if (!entry) {
      return res.status(500).json({ ok: false, error: 'saveMemo failed' });
    }
    return res.json({ ok: true, memo: entry });
  } catch ( e) {
    console.error('[A11][memo] qflush snapshot failed:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message });
  }
});

// --- Mémoire persistante A-11 : key/value ---
const A11_MEMORY_KV_FILE = pathMem.join(A11_MEMORY_ROOT, 'memory.json');

function writeMemoryKeyValue(key, value) {
  try {
    ensureMemoDir(); // pour créer le dossier si besoin
    let data = {};
    if (fsMem.existsSync(A11_MEMORY_KV_FILE)) {
      try {
        data = JSON.parse(fsMem.readFileSync(A11_MEMORY_KV_FILE, 'utf8'));
      } catch {}
    }
    data[key] = value;
    fsMem.writeFileSync(A11_MEMORY_KV_FILE, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, key, value };
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

// --- Route API pour a11_memory_write ---
app.post('/api/a11/memory/write', express.json(), (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'Missing key' });
  const result = writeMemoryKeyValue(key, value);
  if (!result.ok) return res.status(500).json(result);
  return res.json(result);
});

// Ajout du routeur d'historique des conversations A-11
const a11HistoryRouter = require('./routes/a11-history.cjs');
app.use(a11HistoryRouter);

// Ajout du routeur Cerbère (llm-router.cjs)
const llmRouter = require('./llm-router.cjs');
app.use(llmRouter);

// Fallback: ensure server starts
if (!LISTENING) {
  try {
    const HOST = process.env.HOST || '0.0.0.0';
    const server = app.listen(PORT, HOST, () => {
      LISTENING = true;
      const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || 'a11backendrailway.up.railway.app';
      const publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${railwayDomain}`
        : `http://127.0.0.1:${PORT}`;
      console.log(`[A11] Server listening on ${HOST}:${PORT} (public: ${publicUrl})`);
    });
    server.on('error', (error_) => {
      if (error_?.code === 'EADDRINUSE') {
        console.error(`[A11] Port ${PORT} déjà occupé sur ${HOST}. Un autre backend A11 est probablement déjà lancé.`);
      } else {
        console.error('[A11] Failed to start server:', error_?.message || error_);
      }
      process.exit(1);
    });
  } catch (e) {
    console.error('[A11] Failed to start server:', e?.message);
    process.exit(1);
  }
}
