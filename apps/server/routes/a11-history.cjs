const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const router = express.Router();

const WORKSPACE_ROOT = process.env.A11_WORKSPACE_ROOT || 'D:/A12';
const CONV_ROOT = path.join(WORKSPACE_ROOT, 'a11_memory', 'conversations');
const INDEX_PATH = path.join(CONV_ROOT, 'conversations-index.json');

async function ensureDir() {
  await fsp.mkdir(CONV_ROOT, { recursive: true });
}

function sanitizeConversationId(id) {
  return String(id || '').trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
}

function getConversationFilePath(id) {
  const safeId = sanitizeConversationId(id);
  return safeId ? path.join(CONV_ROOT, `conv-${safeId}.jsonl`) : null;
}

async function loadIndex() {
  try {
    const raw = await fsp.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveIndex(index) {
  await ensureDir();
  await fsp.writeFile(INDEX_PATH, JSON.stringify(Array.isArray(index) ? index : [], null, 2), 'utf8');
}

async function getConversationMessages(id) {
  const convPath = getConversationFilePath(id);
  if (!convPath) return [];
  try {
    const raw = await fsp.readFile(convPath, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function deleteConversation(id) {
  const safeId = sanitizeConversationId(id);
  if (!safeId) {
    return { ok: false, removed: false, reason: 'invalid_id' };
  }

  await ensureDir();
  const index = await loadIndex();
  const nextIndex = index.filter((item) => String(item?.id || '') !== safeId);
  const convPath = getConversationFilePath(safeId);

  let fileRemoved = false;
  try {
    if (convPath && fs.existsSync(convPath)) {
      await fsp.unlink(convPath);
      fileRemoved = true;
    }
  } catch {
    fileRemoved = false;
  }

  if (nextIndex.length !== index.length) {
    await saveIndex(nextIndex);
  }

  return {
    ok: true,
    removed: fileRemoved || nextIndex.length !== index.length,
    id: safeId,
  };
}

async function clearAllConversations() {
  await ensureDir();
  let removedFiles = 0;
  let removedConversations = 0;

  const index = await loadIndex();
  removedConversations = index.length;

  try {
    const entries = await fsp.readdir(CONV_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === path.basename(INDEX_PATH) || /^conv-.*\.jsonl$/i.test(entry.name)) {
        try {
          await fsp.unlink(path.join(CONV_ROOT, entry.name));
          removedFiles += 1;
        } catch {
          // ignore individual delete failures
        }
      }
    }
  } catch {
    // ignore directory read failures and still try to reset index below
  }

  await saveIndex([]);

  return {
    ok: true,
    removedFiles,
    removedConversations,
  };
}

// GET /api/a11/history
router.get('/api/a11/history', async (_req, res) => {
  await ensureDir();
  const index = await loadIndex();
  res.json(index);
});

// DELETE /api/a11/history
router.delete('/api/a11/history', async (_req, res) => {
  try {
    const result = await clearAllConversations();
    res.json(result);
  } catch (error_) {
    res.status(500).json({
      ok: false,
      error: 'history_clear_failed',
      message: String(error_?.message || error_),
    });
  }
});

// GET /api/a11/history/:id
router.get('/api/a11/history/:id', async (req, res) => {
  await ensureDir();
  const id = sanitizeConversationId(req.params.id);
  const messages = await getConversationMessages(id);
  res.json({ id, messages });
});

// DELETE /api/a11/history/:id
router.delete('/api/a11/history/:id', async (req, res) => {
  try {
    const result = await deleteConversation(req.params.id);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error_) {
    return res.status(500).json({
      ok: false,
      error: 'history_delete_failed',
      message: String(error_?.message || error_),
    });
  }
});

module.exports = router;
