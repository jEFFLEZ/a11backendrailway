const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const fsSync = require('node:fs');
const { exec } = require('node:child_process');
const { isShellAllowed } = require('../../lib/safe-shell.cjs');

// ⚠️ IMPORTANT : importer le manifest AVANT d'utiliser WORKSPACE_ROOTS
const { TOOL_MANIFEST, WORKSPACE_ROOTS, SAFE_DATA_ROOT } = require('./tools-manifest.cjs');
const { runQflushFlow } = require('../qflush-integration.cjs');
const { callA11Host, getA11HostStatus } = require('../../a11host.cjs');

function resolveSafePath(p, label) {
  const raw = String(p || "").trim();
  if (!raw) throw new Error(`${label || "path"}: empty path not allowed`);
  const target = path.isAbsolute(raw)
    ? path.join(SAFE_DATA_ROOT, path.relative(path.parse(raw).root, raw))
    : path.join(SAFE_DATA_ROOT, raw.replace(/^[/\\]+/, ""));
  if (!target.startsWith(SAFE_DATA_ROOT)) {
    throw new Error(`${label || "path"}: path outside SAFE_DATA_ROOT is forbidden`);
  }
  return target;
}

// ─────────────────────────────
// Base mémoire JSON pour A-11
// ─────────────────────────────

// Workspace de base pour la mémoire.
const DEFAULT_WORKSPACE_ROOT =
  (Array.isArray(WORKSPACE_ROOTS) && WORKSPACE_ROOTS[0]) ||
  process.cwd();

// ⚠️ Renommé → A11_MEMORY_ROOT pour éviter tout conflit avec d'autres modules
const A11_MEMORY_ROOT = path.resolve(DEFAULT_WORKSPACE_ROOT, 'a11_memory');
const A11_MEMO_DIR = path.join(A11_MEMORY_ROOT, 'memos');

function slugifyAssetSegment(value, fallback = 'asset') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function buildGeneratedAssetPath(filename, label = 'generated.outputPath') {
  return resolveSafePath(path.join('generated', filename), label);
}

function buildDownloadedAssetPath(sourceUrl, label = 'download_file.path') {
  const fallbackName = `download-${Date.now()}.png`;
  let filename = fallbackName;
  try {
    const parsed = new URL(String(sourceUrl || ''));
    const rawName = path.basename(parsed.pathname || '') || '';
    const ext = path.extname(rawName).toLowerCase();
    const baseName = path.basename(rawName, ext);
    const safeBase = slugifyAssetSegment(baseName || 'download', 'download');
    const safeExt = /\.(png|jpe?g|gif|webp)$/i.test(ext) ? ext : '.png';
    filename = `${safeBase}-${Date.now()}${safeExt}`;
  } catch {
    filename = fallbackName;
  }
  return resolveSafePath(path.join('downloads', filename), label);
}

function parseImageSize(value, fallbackWidth = 1024, fallbackHeight = 1024) {
  const raw = String(value || '').trim().toLowerCase();
  const match = /^(\d{2,4})\s*[xX]\s*(\d{2,4})$/.exec(raw);
  if (!match) {
    return { width: fallbackWidth, height: fallbackHeight };
  }
  const width = Math.max(64, Math.min(2048, Number(match[1]) || fallbackWidth));
  const height = Math.max(64, Math.min(2048, Number(match[2]) || fallbackHeight));
  return { width, height };
}

function ensureMemoDir() {
  try {
    fs.mkdirSync(A11_MEMO_DIR, { recursive: true });
  } catch (e) {
    console.warn('[A11][tools-memo] mkdir failed:', e && e.message);
  }
}

function saveMemoEntry(type, data) {
  try {
    ensureMemoDir();
    const ts = new Date().toISOString();
    const safeType = (type || 'generic').replace(/[^a-z0-9_\-]/gi, '_');
    const id = `${ts.replace(/[:.]/g, '-')}_${safeType}`;
    const entry = { id, type: safeType, ts, data };
    const file = path.join(A11_MEMO_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8');
    return entry;
  } catch (e) {
    console.warn('[A11][tools-memo] save failed:', e && e.message);
    return null;
  }
}

// Tool accessible via Cerbère / A-11 pour enregistrer un mémo JSON
async function t_a11_save_memo(args = {}) {
  const { type, data } = args;
  if (!type) throw new Error('a11_save_memo: missing "type"');
  const entry = saveMemoEntry(type, data ?? {});
  if (!entry) {
    return { ok: false, error: 'saveMemoEntry failed' };
  }
  return { ok: true, memo: entry };
}

// Mémoire persistante A-11
const MEMORY_FACTS_PATH = path.join(A11_MEMORY_ROOT, 'facts.json');

async function ensureMemoryFolder() {
  try {
    await fsp.mkdir(A11_MEMORY_ROOT, { recursive: true });
    if (!fsSync.existsSync(MEMORY_FACTS_PATH)) {
      await fsp.writeFile(MEMORY_FACTS_PATH, '{}', 'utf8');
    }
  } catch (e) {
    console.warn('[A11][memory] ensureMemoryFolder error:', e && e.message);
  }
}

async function loadFacts() {
  await ensureMemoryFolder();
  try {
    const raw = await fsp.readFile(MEMORY_FACTS_PATH, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveFacts(obj) {
  await ensureMemoryFolder();
  const safe = obj && typeof obj === 'object' ? obj : {};
  await fsp.writeFile(MEMORY_FACTS_PATH, JSON.stringify(safe, null, 2), 'utf8');
}

async function t_download_file(args = {}) {
  const { url } = args;

  if (!url || typeof url !== 'string') {
    throw new Error('download_file: missing "url"');
  }

  // 🔒 Garde-fou anti-URL factice (example.com, dummy, about:blank, etc.)
  const lower = url.toLowerCase();
  if (
    lower.includes('example.com') ||
    lower.includes('dummy') ||
    lower === 'about:blank' ||
    lower.startsWith('data:')
  ) {
    return {
      ok: false,
      url,
      outputPath: null,
      error: 'invalid_dummy_url',
      message:
        'download_file: refused dummy URL (example.com / dummy / about:blank / data:). ' +
        'Le LLM doit appeler web_search puis utiliser une URL réelle.'
    };
  }

  const filePath = args.path || args.outputPath
    ? resolveSafePath(args.path || args.outputPath, 'download_file.path')
    : buildDownloadedAssetPath(url, 'download_file.path');

  // 🔒 N'accepte que des extensions d'image directes
  function looksLikeImageUrl(url) {
    return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url.split('?')[0]);
  }
  if (!looksLikeImageUrl(url)) {
    return {
      ok: false,
      url,
      outputPath: filePath || null,
      error: 'invalid_extension',
      message:
        'download_file: URL must point to a direct image file (.png, .jpg, .jpeg, .gif, .webp).'
    };
  }

  let response;
  try {
    response = await axios.get(url, {
      responseType: 'arraybuffer',
      validateStatus: s => s >= 200 && s < 400, // handle errors manually
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
  } catch (e) {
    return {
      ok: false,
      url,
      outputPath: filePath,
      error: String(e && e.message)
    };
  }

  if (response.status >= 400) {
    return {
      ok: false,
      url,
      outputPath: filePath,
      status: response.status,
      error: `HTTP ${response.status}`
    };
  }

  // 🔒 Vérifie le content-type
  const contentType = response.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    return {
      ok: false,
      url,
      outputPath: filePath,
      error: 'not_image_content_type',
      message: `download_file: Content-Type is not image/* (${contentType})`
    };
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, response.data);

  // --- Validation post-download (anti-placeholder/erreur) ---
  let sharp, stat, meta;
  try {
    sharp = require('sharp');
    stat = await fsp.stat(filePath);
    if (stat.size < 8000) {
      return { ok: false, error: "BAD_IMAGE_TOO_SMALL", path: filePath };
    }
    meta = await sharp(filePath).metadata();
    if (!meta.width || !meta.height) {
      return { ok: false, error: "BAD_IMAGE_NO_METADATA", path: filePath };
    }
    if (meta.width < 350 && meta.height < 350) {
      return { ok: false, error: "BAD_IMAGE_PLACEHOLDER_DIMENSIONS", path: filePath, meta };
    }
  } catch (e) {
    return { ok: false, error: "BAD_IMAGE_VALIDATION_FAILED", details: e?.message, path: filePath };
  }

  return { ok: true, url, outputPath: filePath, meta };
}

function isPathInRoots(p) {
  const resolved = path.resolve(p);
  return WORKSPACE_ROOTS.some(root => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
}

function assertPathAllowed(p, label = 'path') {
  if (!p || typeof p !== 'string') {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (!isPathInRoots(p)) {
    throw new Error(`Path outside allowed roots: ${p}`);
  }
}

const PROTECTED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.env',
  '.a11_backups',
  '.qflash',
  '.qflush'
]);

const SAFE_MODE = String(process.env.A11_SAFE_MODE ?? 'true').toLowerCase() !== 'false';

function hasDeleteConfirmation(args = {}) {
  const token = String(args.confirm || args.confirmation || '').trim();
  return args.confirmDelete === true && token === 'DELETE';
}

function isProtectedPath(targetPath) {
  const normalized = path.resolve(String(targetPath || '')).toLowerCase();
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.some((segment) => PROTECTED_PATH_SEGMENTS.has(segment));
}

function assertDeleteGuards(targetPath, args = {}) {
  console.log('[A11 ACTION]', {
    action: 'delete',
    path: targetPath,
    user: args.user || args.requestedBy || 'unknown',
    timestamp: Date.now()
  });
  if (SAFE_MODE) {
    throw new Error('delete operation refused: SAFE_MODE is enabled');
  }
  if (!hasDeleteConfirmation(args)) {
    throw new Error(
      'delete operation refused: explicit confirmation required (confirmDelete=true and confirm="DELETE")'
    );
  }
  if (isProtectedPath(targetPath)) {
    throw new Error(`delete operation refused on protected path: ${targetPath}`);
  }
}

function ensureToolAvailable(name) {
  const spec = TOOL_MANIFEST[name];
  if (!spec) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return spec;
}

// QFLUSH
async function t_qflush_flow(args = {}) {
  const { flow, payload } = args;
  if (!flow || typeof flow !== 'string') {
    throw new Error('qflush_flow: missing "flow"');
  }
  return await runQflushFlow(flow, payload || {});
}

// FS
async function t_fs_read(args = {}) {
  const { path: filePath } = args;
  assertPathAllowed(filePath, 'fs_read.path');
  const data = await fsp.readFile(filePath, 'utf8');
  return { ok: true, path: filePath, content: data };
}

async function t_fs_write(args = {}) {
  const { path: filePath, content, overwrite } = args;
  assertPathAllowed(filePath, 'fs_write.path');
  if (!overwrite && fsSync.existsSync(filePath)) {
    throw new Error(`fs_write: file already exists and overwrite=false: ${filePath}`);
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, String(content || ''), 'utf8');
  return { ok: true, path: filePath };
}

async function t_write_file(args = {}) {
  const rawPath = args.path;
  const filePath = resolveSafePath(rawPath, "write_file.path");
  if (!args.overwrite && fsSync.existsSync(filePath)) {
    throw new Error(`write_file: file already exists and overwrite=false: ${filePath}`);
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, String(args.content || ''), 'utf8');
  return { ok: true, path: filePath };
}

async function t_fs_list(args = {}) {
  const { path: dirPath } = args;
  assertPathAllowed(dirPath, 'fs_list.path');
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
  return { ok: true, path: dirPath, items };
}

async function t_fs_stat(args = {}) {
  const { path: p } = args;
  assertPathAllowed(p, 'fs_stat.path');
  const st = await fsp.stat(p);
  return {
    ok: true,
    path: p,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    size: st.size,
    mtime: st.mtimeMs,
    ctime: st.ctimeMs
  };
}

async function t_fs_delete(args = {}) {
  const { path: p } = args;
  assertPathAllowed(p, 'fs_delete.path');
  assertDeleteGuards(p, args);
  if (!fsSync.existsSync(p)) {
    return { ok: true, deleted: false, reason: 'not_exists', path: p };
  }
  const st = await fsp.stat(p);
  if (st.isDirectory()) {
    await fsp.rm(p, { recursive: true, force: true });
  } else {
    await fsp.unlink(p);
  }
  return { ok: true, deleted: true, path: p };
}

async function t_fs_move(args = {}) {
  const { from, to } = args;
  assertPathAllowed(from, 'fs_move.from');
  assertPathAllowed(to, 'fs_move.to');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return { ok: true, from, to };
}

// ZIP (stub)
async function t_zip_create(args = {}) {
  const { inputPaths, outputPath } = args;
  assertPathAllowed(outputPath, 'zip_create.outputPath');
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('zip_create: inputPaths must be a non-empty array');
  }
  inputPaths.forEach(p => assertPathAllowed(p, 'zip_create.inputPaths'));
  return { ok: true, outputPath, stub: true };
}

async function t_unzip_extract(args = {}) {
  const { zipPath, outputDir } = args;
  assertPathAllowed(zipPath, 'unzip_extract.zipPath');
  assertPathAllowed(outputDir, 'unzip_extract.outputDir');
  return { ok: true, zipPath, outputDir, stub: true };
}

// SHELL
async function t_shell_exec(args = {}) {
  const { command, cwd } = args;
  if (!isShellAllowed(command)) {
    throw new Error(`shell_exec: command not allowed by whitelist: "${command}"`);
  }
  if (cwd) assertPathAllowed(cwd, 'shell_exec.cwd');
  return new Promise((resolve) => {
    exec(command, { cwd: cwd || undefined }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          command,
          exitCode: err.code ?? -1,
          stdout: stdout?.toString() || '',
          stderr: stderr?.toString() || err.message
        });
      }
      resolve({
        ok: true,
        command,
        exitCode: 0,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || ''
      });
    });
  });
}

// WEB (via QFLUSH flow)
async function t_web_fetch(args = {}) {
  const { url } = args;
  if (!url || typeof url !== 'string') {
    throw new Error('web_fetch: missing "url"');
  }
  return await runQflushFlow('web_fetch', { url });
}

// WEB SEARCH (DuckDuckGo minimal)
async function t_web_search(args = {}) {
  const { query, limit } = args;
  const q = (query || "").toString().trim();
  const max = typeof limit === "number" && limit > 0 && limit <= 10 ? limit : 5;

  if (!q) {
    throw new Error("web_search: missing 'query'");
  }

  const url = "https://duckduckgo.com/html/?q=" + encodeURIComponent(q);

  const resp = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
  });

  const html = resp.data || "";
  const results = [];
  // Extraction des liens classiques
  const regex = /<a[^>]+class=\"result__a\"[^>]*href=\"([^\"]+)\"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class=\"result__snippet\"[^>]*>(.*?)<\/a>/gi;

  let match;
  while ((match = regex.exec(html)) && results.length < max) {
    const href = match[1];
    const rawTitle = match[2] || "";
    const rawSnippet = match[3] || "";

    const title = rawTitle.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const snippet = rawSnippet.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

    results.push({
      title,
      url: href,
      snippet,
      isImage: false
    });
  }

  // Extraction des liens directs d'images (png, jpg, jpeg, gif, webp)
  const imgRegex = /https?:\/\/(?:[\w.-]+)\/(?:[\w\/-]+)\.(?:png|jpg|jpeg|gif|webp)/gi;
  const imgUrls = html.match(imgRegex) || [];
  for (const imgUrl of imgUrls) {
    // Éviter les doublons
    if (!results.some(r => r.url === imgUrl)) {
      results.push({
        title: 'Image',
        url: imgUrl,
        snippet: '',
        isImage: true
      });
    }
  }

  // Prioriser les images dans le tableau results
  results.sort((a, b) => (a.isImage === b.isImage ? 0 : a.isImage ? -1 : 1));

  return {
    ok: true,
    query: q,
    results
  };
}

// FS SEARCH (via QFlush)
async function t_fs_search(args = {}) {
  // Appelle QFlush pour effectuer la recherche de fichiers
  return await runQflushFlow('fs.search', args);
}

// LLM ANALYSE (stub)
async function t_llm_analyze_text(args = {}) {
  const { text, task } = args;
  if (!text || typeof text !== 'string') {
    throw new Error('llm_analyze_text: missing "text"');
  }
  return {
    ok: true,
    task: task || 'none',
    textPreview: text.slice(0, 400)
  };
}

// Helper pour charger une image (URL ou path)
async function loadImageBuffer(ref) {
  if (!ref || typeof ref !== 'string') return null;

  // URL HTTP/HTTPS
  if (/^https?:\/\//i.test(ref)) {
    try {
      const r = await fetch(ref);
      if (!r.ok) {
        console.warn('[generate_pdf] image URL failed:', ref, r.status);
        return null;
      }
      const ab = await r.arrayBuffer();
      return Buffer.from(ab);
    } catch (e) {
      console.warn('[generate_pdf] image URL error:', ref, e && e.message);
      return null;
    }
  }

  // Chemin local
  let filePath = String(ref).trim();
  if (!path.isAbsolute(filePath)) {
    filePath = resolveSafePath(filePath, 'generate_pdf.image');
  }

  try {
    return await fsp.readFile(filePath);
  } catch (e) {
    console.warn('[generate_pdf] image file not found:', filePath);
    return null;
  }
}

// PDF (generate)
async function t_generate_pdf(args = {}) {
  let { outputPath, title, content, sections, author, date } = args;

  outputPath = outputPath
    ? resolveSafePath(outputPath, 'generate_pdf.outputPath')
    : buildGeneratedAssetPath(`expose_${Date.now()}.pdf`, 'generate_pdf.outputPath');

  // Securise la création du dossier avant d'écrire le PDF
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  title = title || "Exposé de Lycéen";
  author = author || "Auteur: Anonyme";
  date = date || new Date().toLocaleDateString();
  sections = Array.isArray(sections) ? sections : [];

  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // ----------- Page de garde -----------
  doc
    .fontSize(28)
    .fillColor('#2563eb')
    .font("Helvetica-Bold")
    .text(title, { align: "center" })
    .moveDown(2)
    .fontSize(18)
    .fillColor('#111827')
    .font("Helvetica")
    .text(author, { align: "center" })
    .moveDown(1)
    .text(date, { align: "center" })
    .moveDown(4);
  doc.addPage();

  // ----------- Sommaire -----------
  doc.fontSize(20).fillColor('#22c55e').font("Helvetica-Bold").text("Sommaire", { align: "left" }).moveDown(1);
  for (let idx = 0; idx < sections.length; idx++) {
    const section = sections[idx];
    const heading = section.heading || section.title || `Section ${idx + 1}`;
    doc.fontSize(14).fillColor('#0ea5e9').font("Helvetica").text(`${idx + 1}. ${heading}`, { align: "left" });
  }
  doc.moveDown(2);
  doc.addPage();

  // ----------- Sections -----------
  for (let idx = 0; idx < sections.length; idx++) {
    const section = sections[idx];
    const heading = section.heading || section.title || `Section ${idx + 1}`;
    const text = section.text || section.content || "";
    const images = Array.isArray(section.images) ? section.images : [];

    doc.fontSize(18).fillColor('#2563eb').font("Helvetica-Bold").text(heading, { align: "left" }).moveDown(1);
    if (text) {
      doc.fontSize(12).fillColor('#111827').font("Helvetica").text(text, { align: "left" }).moveDown(1);
    }
    // Images centrées
    for (const ref of images) {
      const buf = await loadImageBuffer(ref);
      if (!buf) continue;
      const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.moveDown(0.5).image(buf, {
        fit: [maxWidth * 0.8, 250],
        align: "center",
        valign: "center"
      }).moveDown(1);
    }
    doc.addPage();
  }

  // ----------- Conclusion -----------
  doc.fontSize(20).fillColor('#eab308').font("Helvetica-Bold").text("Conclusion", { align: "left" }).moveDown(1);
  doc.fontSize(12).fillColor('#111827').font("Helvetica").text("Merci d'avoir lu cet exposé !", { align: "left" }).moveDown(2);

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return {
    ok: true,
    outputPath
  };
}

// PNG placeholder generator (safe fallback for dev actions)
async function t_generate_png(args = {}) {
  const sharp = require('sharp');
  const size = parseImageSize(args.imageSize, Number(args.width || 1024), Number(args.height || 1024));
  const width = Math.max(64, Math.min(2048, Number(args.width || size.width || 1024)));
  const height = Math.max(64, Math.min(2048, Number(args.height || size.height || 1024)));
  const title = String(
    args.text ||
    args.prompt ||
    args.imageDescription ||
    args.imageType ||
    'Illustration A11'
  ).trim() || 'Illustration A11';
  const subtitle = String(args.subtitle || 'Image de secours generee par A11').trim();
  const baseName = `${slugifyAssetSegment(title, 'image')}-${Date.now()}.png`;
  const outputPath = args.outputPath || args.path || args.imagePath
    ? resolveSafePath(args.outputPath || args.path || args.imagePath, 'generate_png.outputPath')
    : buildGeneratedAssetPath(baseName, 'generate_png.outputPath');

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  const safeTitle = title
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const safeSubtitle = subtitle
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" rx="28" fill="url(#bg)"/>
      <circle cx="${Math.round(width * 0.78)}" cy="${Math.round(height * 0.22)}" r="${Math.round(Math.min(width, height) * 0.09)}" fill="#38bdf8" fill-opacity="0.22"/>
      <circle cx="${Math.round(width * 0.18)}" cy="${Math.round(height * 0.76)}" r="${Math.round(Math.min(width, height) * 0.11)}" fill="#f59e0b" fill-opacity="0.18"/>
      <text x="50%" y="42%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(28, Math.round(Math.min(width, height) * 0.08))}" font-weight="700" fill="#f8fafc">${safeTitle}</text>
      <text x="50%" y="58%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(16, Math.round(Math.min(width, height) * 0.035))}" fill="#cbd5e1">${safeSubtitle}</text>
      <text x="50%" y="84%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(12, Math.round(Math.min(width, height) * 0.024))}" fill="#93c5fd">A11 placeholder PNG</text>
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  return {
    ok: true,
    outputPath,
    width,
    height,
    mode: 'placeholder',
    prompt: title,
  };
}

// VS / A11Host
async function t_vs_status() {
  return await getA11HostStatus();
}

async function requireA11HostCapability(capabilityKey, unavailableError) {
  const status = await getA11HostStatus();
  if (!status.capabilities?.[capabilityKey]) {
    return {
      ok: false,
      error: unavailableError,
      mode: status.mode,
      bridgeAvailable: status.bridgeAvailable,
      capabilities: status.capabilities
    };
  }
  return status;
}

function parseA11HostPayload(payload, fallbackKey) {
  if (typeof payload !== 'string') {
    return fallbackKey ? { [fallbackKey]: payload } : payload;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return fallbackKey ? { [fallbackKey]: payload } : payload;
  }
}

async function t_vs_workspace_root() {
  const status = await requireA11HostCapability('workspaceRoot', 'vs_workspace_root unavailable');
  if (!status.ok) return status;

  const root = await callA11Host('GetWorkspaceRoot');
  return {
    ok: true,
    root,
    mode: status.mode
  };
}

async function t_vs_compilation_errors() {
  const status = await requireA11HostCapability('compilationErrors', 'vs_compilation_errors unavailable');
  if (!status.ok) return status;

  const payload = await callA11Host('GetCompilationErrors');
  const parsed = parseA11HostPayload(payload, 'errors');
  const errors = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.errors) ? parsed.errors : []);
  return {
    ok: true,
    errors,
    raw: parsed,
    mode: status.mode
  };
}

async function t_vs_project_structure() {
  const status = await requireA11HostCapability('projectStructure', 'vs_project_structure unavailable');
  if (!status.ok) return status;

  const payload = await callA11Host('GetProjectStructure');
  const parsed = parseA11HostPayload(payload, 'projectStructure');
  return {
    ok: true,
    projectStructure: parsed,
    mode: status.mode
  };
}

async function t_vs_solution_info() {
  const status = await requireA11HostCapability('solutionInfo', 'vs_solution_info unavailable');
  if (!status.ok) return status;

  const payload = await callA11Host('GetSolutionInfo');
  const parsed = parseA11HostPayload(payload, 'solutionInfo');
  return {
    ok: true,
    solutionInfo: parsed,
    mode: status.mode
  };
}

async function t_vs_active_document() {
  const status = await requireA11HostCapability('activeDocument', 'vs_active_document unavailable');
  if (!status.ok) return status;

  const payload = await callA11Host('GetActiveDocument');
  const parsed = parseA11HostPayload(payload, 'document');
  return {
    ok: true,
    document: parsed,
    mode: status.mode
  };
}

async function t_vs_current_selection() {
  const status = await requireA11HostCapability('currentSelection', 'vs_current_selection unavailable');
  if (!status.ok) return status;

  const payload = await callA11Host('GetCurrentSelection');
  const parsed = parseA11HostPayload(payload, 'text');
  const text = typeof parsed === 'string'
    ? parsed
    : (typeof parsed?.text === 'string' ? parsed.text : String(parsed?.text || ''));
  return {
    ok: true,
    text,
    raw: parsed,
    mode: status.mode
  };
}

async function t_vs_open_file(args = {}) {
  const filePath = String(args.path || '').trim();
  if (!filePath) {
    throw new Error('vs_open_file: missing "path"');
  }

  const status = await requireA11HostCapability('openFile', 'vs_open_file unavailable');
  if (!status.ok) return status;

  const success = await callA11Host('OpenFile', filePath);
  return {
    ok: true,
    success,
    path: filePath,
    mode: status.mode
  };
}

async function t_vs_goto_line(args = {}) {
  const filePath = String(args.path || '').trim();
  const line = Number(args.line);
  if (!filePath) {
    throw new Error('vs_goto_line: missing "path"');
  }
  if (!Number.isInteger(line) || line < 1) {
    throw new Error('vs_goto_line: invalid "line"');
  }

  const status = await requireA11HostCapability('gotoLine', 'vs_goto_line unavailable');
  if (!status.ok) return status;

  const success = await callA11Host('GotoLine', filePath, line);
  return {
    ok: true,
    success,
    path: filePath,
    line,
    mode: status.mode
  };
}

async function t_vs_open_documents() {
  const status = await requireA11HostCapability('openDocuments', 'vs_open_documents unavailable');
  if (!status.ok) return status;

  const docs = await callA11Host('GetOpenDocuments');
  let documents = docs;
  if (typeof docs === 'string') {
    try {
      documents = JSON.parse(docs);
    } catch {
      documents = [docs];
    }
  }

  return {
    ok: true,
    documents,
    mode: status.mode
  };
}

async function t_vs_execute_shell(args = {}) {
  const command = String(args.command || '').trim();
  if (!command) {
    throw new Error('vs_execute_shell: missing "command"');
  }
  if (!isShellAllowed(command)) {
    return {
      ok: false,
      error: `vs_execute_shell: command not allowed by whitelist: "${command}"`,
      command
    };
  }

  const status = await requireA11HostCapability('executeShell', 'vs_execute_shell unavailable');
  if (!status.ok) return status;

  try {
    const output = await callA11Host('ExecuteShell', command);
    return {
      ok: true,
      command,
      output,
      mode: status.mode
    };
  } catch (err) {
    return {
      ok: false,
      command,
      mode: status.mode,
      error: err?.message || String(err)
    };
  }
}

async function t_vs_build_solution() {
  const status = await requireA11HostCapability('buildSolution', 'vs_build_solution unavailable');
  if (!status.ok) return status;

  const success = await callA11Host('BuildSolution');
  return {
    ok: true,
    success,
    mode: status.mode
  };
}

async function t_a11_env_snapshot(_args = {}) {
  const tools = Object.keys(TOOL_IMPL || {}).sort();
  const roots = WORKSPACE_ROOTS.map(r => path.resolve(r));
  const qflushInfo = {
    available: !!globalThis.__QFLUSH_AVAILABLE,
    module: !!globalThis.__QFLUSH_MODULE,
    exePath: globalThis.__QFLUSH_PATH || null
  };
  let llmStats = null;
  try {
    const routerUrl = (process.env.LLM_ROUTER_URL && process.env.LLM_ROUTER_URL.trim()) || 'http://127.0.0.1:4545';
    const url = String(routerUrl).replace(/\/$/, '') + '/api/stats';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      llmStats = await r.json();
    } else {
      llmStats = { ok: false, status: r.status };
    }
  } catch (e) {
    llmStats = { ok: false, error: String(e && e.message) };
  }
  const SAFE_ENV_KEYS = [
    'NODE_ENV','BACKEND','LLAMA_BASE','LLAMA_PORT','LLM_ROUTER_URL','PORT','HOST_SERVER'
  ];
  const safeEnv = {};
  for (const k of SAFE_ENV_KEYS) {
    if (process.env[k] !== undefined) safeEnv[k] = process.env[k];
  }
  const workspaces = [];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = await fsp.readdir(root, { withFileTypes: true });
      workspaces.push({
        root,
        entries: entries.filter(e => e.isDirectory()).slice(0, 20).map(e => e.name)
      });
    } catch (e) {
      workspaces.push({ root, error: String(e && e.message) });
    }
  }
  const snapshot = {
    timestamp: Date.now(),
    mode: process.env.NODE_ENV || 'development',
    tools,
    roots,
    qflush: qflushInfo,
    llm: llmStats,
    env: safeEnv,
    workspaces
  };
  return { ok: true, snapshot };
}

async function t_a11_debug_echo(args = {}) {
  return { ok: true, echo: args, type: typeof args };
}

// --- KV store pour a11_memory_* ---
const A11_KV_ROOT = path.resolve((WORKSPACE_ROOTS[1] || WORKSPACE_ROOTS[0]), 'a11_memory');
const A11_KV_STORE_PATH = path.join(A11_KV_ROOT, 'kv-store.json');

function ensureKvDir() {
  try {
    fsSync.mkdirSync(A11_KV_ROOT, { recursive: true });
  } catch (e) {
    console.warn('[A11][kv] mkdir failed:', e && e.message);
  }
}

function loadKvStore() {
  try {
    ensureKvDir();
    if (!fsSync.existsSync(A11_KV_STORE_PATH)) return {};
    const raw = fsSync.readFileSync(A11_KV_STORE_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[A11][kv] load failed:', e && e.message);
    return {};
  }
}

function saveKvStore(store) {
  try {
    ensureKvDir();
    fsSync.writeFileSync(
      A11_KV_STORE_PATH,
      JSON.stringify(store, null, 2),
      'utf8'
    );
  } catch (e) {
    console.warn('[A11][kv] save failed:', e && e.message);
  }
}

async function t_a11_memory_write(args = {}) {
  const key = (args.key || '').toString().trim();
  const value = args.value;

  if (!key) {
    throw new Error('a11_memory_write: missing "key"');
  }

  // 1. Enregistrement dans le KV store
  const store = loadKvStore();
  store[key] = {
    value,
    updatedAt: new Date().toISOString()
  };
  saveKvStore(store);

  // 2. Enregistrement dans le fichier de log (conversations)
  // Si la clé est "conversations" ou "log", on écrit aussi dans le fichier texte
  if (key === 'conversations' || key === 'log') {
    const convDir = path.join(A11_KV_ROOT, 'conversations');
    try {
      fsSync.mkdirSync(convDir, { recursive: true });
      const logPath = path.join(convDir, 'log.txt');
      fsSync.appendFileSync(logPath, String(value) + '\n', 'utf8');
    } catch (e) {
      console.warn('[A11][kv] log.txt write failed:', e && e.message);
    }
  }

  return {
    ok: true,
    key,
    value
  };
}

async function t_a11_memory_read(args = {}) {
  const key = (args.key || '').toString().trim();
  if (!key) {
    throw new Error('a11_memory_read: missing "key"');
  }

  const store = loadKvStore();
  const exists = Object.prototype.hasOwnProperty.call(store, key);

  return {
    ok: true,
    key,
    exists,
    value: exists ? store[key].value : null,
    meta: exists ? store[key] : null
  };
}

// Nouveau: historique simple
async function t_a11_memory_history(args = {}) {
  const prefix = (args.prefix || '').toString().trim();

  // --- KV store ---
  const kv = loadKvStore();
  const kvKeys = Object.keys(kv).sort();
  const kvFiltered = prefix ? kvKeys.filter(k => k.startsWith(prefix)) : kvKeys;
  const kvItems = kvFiltered.map(k => ({
    type: 'kv',
    key: k,
    updatedAt: kv[k].updatedAt,
    summary: (typeof kv[k].value === 'string'
      ? kv[k].value.slice(0, 80)
      : JSON.stringify(kv[k].value).slice(0, 80))
  }));

  // --- Conversations ---
  const convDir = path.join(A11_MEMORY_ROOT, 'conversations');
  let convItems = [];
  try {
    if (fsSync.existsSync(convDir)) {
      const files = fsSync.readdirSync(convDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort();
      for (const file of files) {
        const fullPath = path.join(convDir, file);
        const stat = fsSync.statSync(fullPath);
        let preview = '';
        try {
          const raw = fsSync.readFileSync(fullPath, 'utf8');
          const lines = raw.split('\n').filter(Boolean);
          preview = lines.slice(0, 2).join('\n');
          if (preview.length > 400) preview = preview.slice(0, 400) + '...';
        } catch {}
        convItems.push({
          type: 'conversation',
          file,
          updatedAt: stat.mtime.toISOString?.() || new Date(stat.mtime).toISOString(),
          summary: preview
        });
      }
    }
  } catch (e) {
    console.warn('[A11][memory_history] conv error:', e && e.message);
  }

  // --- Memos ---
  const memoDir = path.join(A11_MEMORY_ROOT, 'memos');
  let memoItems = [];
  try {
    if (fsSync.existsSync(memoDir)) {
      const files = fsSync.readdirSync(memoDir)
        .filter(f => f.endsWith('.json'))
        .sort();
      for (const file of files) {
        const fullPath = path.join(memoDir, file);
        const stat = fsSync.statSync(fullPath);
        let preview = '';
        let type = 'memo';
        try {
          const raw = fsSync.readFileSync(fullPath, 'utf8');
          const obj = JSON.parse(raw);
          type = obj.type || 'memo';
          preview = JSON.stringify(obj.data || obj, null, 2).slice(0, 400);
        } catch {}
        memoItems.push({
          type,
          file,
          updatedAt: stat.mtime.toISOString?.() || new Date(stat.mtime).toISOString(),
          summary: preview
        });
      }
    }
  } catch (e) {
    console.warn('[A11][memory_history] memo error:', e && e.message);
  }

  // --- Fusion ---
  const items = [...kvItems, ...convItems, ...memoItems];

  return {
    ok: true,
    total: kvKeys.length + convItems.length + memoItems.length,
    filtered: items.length,
    items
  };
}

// --- TTS stubs (en attendant le vrai câblage) ---
async function t_tts_basic(args = {}) {
  return {
    ok: false,
    error: 't_tts_basic not wired yet',
    args
  };
}

async function t_tts_advanced(args = {}) {
  return {
    ok: false,
    error: 't_tts_advanced not wired yet',
    args
  };
}

const TOOL_IMPL = {
  // QFlush
  qflush_flow: t_qflush_flow,

  // FS
  fs_read: t_fs_read,
  fs_write: t_fs_write,
  write_file: t_write_file,
  fs_list: t_fs_list,
  fs_stat: t_fs_stat,
  fs_delete: t_fs_delete,
  fs_move: t_fs_move,

  // ZIP (stubs)
  zip_create: t_zip_create,
  unzip_extract: t_unzip_extract,

  // SHELL
  shell_exec: t_shell_exec,

  // WEB
  web_fetch: t_web_fetch,
  web_search: t_web_search,

  // FS via QFlush
  fs_search: t_fs_search,

  // LLM
  llm_analyze_text: t_llm_analyze_text,

  // VS / A11Host
  vs_status: t_vs_status,
  vs_workspace_root: t_vs_workspace_root,
  vs_compilation_errors: t_vs_compilation_errors,
  vs_project_structure: t_vs_project_structure,
  vs_solution_info: t_vs_solution_info,
  vs_active_document: t_vs_active_document,
  vs_current_selection: t_vs_current_selection,
  vs_open_file: t_vs_open_file,
  vs_goto_line: t_vs_goto_line,
  vs_open_documents: t_vs_open_documents,
  vs_execute_shell: t_vs_execute_shell,
  vs_build_solution: t_vs_build_solution,

  // PDF / PNG
  generate_pdf: t_generate_pdf,
  generate_png: t_generate_png,

  // Download direct d’image/fichier
  download_file: t_download_file,

  // TTS (stubs pour l’instant)
  tts_basic: t_tts_basic,
  tts_advanced: t_tts_advanced,

  // Mémoire A-11 (KV + historique)
  a11_memory_write: t_a11_memory_write,
  a11_memory_read: t_a11_memory_read,
  a11_memory_history: t_a11_memory_history
};

// --- Ajout: Validation stricte des noms d'actions ---
const ALLOWED_ACTIONS = new Set(Object.keys(TOOL_IMPL));
function validateActionName(name) {
  if (!ALLOWED_ACTIONS.has(name)) {
    return { ok: false, error: `UNKNOWN_ACTION:${name}`, available: [...ALLOWED_ACTIONS] };
  }
  return { ok: true };
}

async function runAction(name, args = {}) {
  if (!TOOL_IMPL[name]) {
    return {
      ok: false,
      error: `Unknown tool: ${name}`,
      available: Object.keys(TOOL_IMPL)
    };
  }
  const spec = ensureToolAvailable(name);
  const impl = TOOL_IMPL[name];
  console.log(`[Cerbère][tool] ${name} (danger=${spec.dangerLevel || 'unknown'})`, args);
  try {
    const result = await impl(args);
    return { tool: name, ok: true, result };
  } catch (err) {
    return {
      tool: name,
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack || null
    };
  }
}

function isIgnoredMemoryKey(actionName, args) {
  if (actionName !== "a11_memory_write" && actionName !== "a11_memory_read") {
    return false;
  }
  const key = args?.key || args?.input?.key || args?.arguments?.key;
  if (!key) return false;
  const k = String(key);
  if (
    k === "workspace" ||
    k === "conversation" ||
    k === "conversation_path" ||
    k.startsWith("conversation_")
  ) {
    return true;
  }
  return false;
}

// --- PATCH: Normalize envelope (result -> actions) and sequential execution with validation ---
async function runActionsEnvelope(envelope) {
  // Normalize: accept legacy {result: {...}} as {actions: [result]}
  if (!envelope.actions && envelope.result) {
    envelope.actions = [envelope.result];
  }
  if (!Array.isArray(envelope.actions)) {
    throw new Error("runActionsEnvelope: envelope must have actions[] array");
  }
  const results = [];
  for (const a of envelope.actions) {
    const name = a.action || a.name;
    const args = a.arguments || a.input || {};
    // Validation stricte du nom d'action
    const valid = validateActionName(name);
    if (!valid.ok) {
      results.push({
        action: name,
        ok: false,
        error: valid.error,
        available: valid.available
      });
      break; // Stop batch on invalid action
    }
    if (isIgnoredMemoryKey(name, args)) {
      console.log("[A11][memory] Ignoring", name, "for reserved key:", args.key || args.input?.key);
      results.push({ action: name, ignored: true, reason: "reserved-memory-key" });
      continue;
    }
    // Validation download_file: url obligatoire
    if (name === "download_file") {
      const url = String(args.url || "").trim();
      if (!url) {
        results.push({
          action: name,
          ok: false,
          error: "download_file: missing url (must be filled after websearch result)",
          arguments: args
        });
        break; // Stop batch if download_file is incomplete
      }
    }
    if (name === 'fs_delete') {
      if (SAFE_MODE) {
        results.push({
          action: name,
          ok: false,
          error: 'fs_delete: SAFE_MODE is enabled',
          arguments: args
        });
        break;
      }
      if (!hasDeleteConfirmation(args)) {
        results.push({
          action: name,
          ok: false,
          error: 'fs_delete: explicit confirmation required (confirmDelete=true and confirm="DELETE")',
          arguments: args
        });
        break;
      }
      if (isProtectedPath(args.path)) {
        results.push({
          action: name,
          ok: false,
          error: `fs_delete: protected path denied (${args.path})`,
          arguments: args
        });
        break;
      }
    }
    try {
      const result = await TOOL_IMPL[name](args);
      results.push({ action: name, ok: true, result });
    } catch (err) {
      results.push({
        action: name,
        ok: false,
        error: err?.message || String(err),
        stack: err?.stack || null
      });
    }
    // Si l'action est websearch, on s'arrête là pour reprompt LLM avec TOOL_RESULTS
    if (name === "websearch" || name === "web_search") break;
  }
  return { ok: true, results };
}

module.exports = {
  t_a11_save_memo,
  t_a11_memory_write,
  t_a11_memory_read,
  t_a11_memory_history,
  t_download_file,
  t_qflush_flow,
  t_fs_read,
  t_fs_write,
  t_write_file,
  t_fs_list,
  t_fs_stat,
  t_fs_delete,
  t_fs_move,
  t_zip_create,
  t_unzip_extract,
  t_shell_exec,
  t_web_fetch,
  t_web_search,
  t_fs_search,
  t_llm_analyze_text,
  t_generate_pdf,
  t_generate_png,
  t_vs_status,
  t_vs_workspace_root,
  t_vs_compilation_errors,
  t_vs_project_structure,
  t_vs_solution_info,
  t_vs_active_document,
  t_vs_current_selection,
  t_vs_open_file,
  t_vs_goto_line,
  t_vs_open_documents,
  t_vs_execute_shell,
  t_vs_build_solution,
  t_a11_env_snapshot,
  t_a11_debug_echo,
  runAction,
  runActionsEnvelope,
  isIgnoredMemoryKey
};
