// routes/dev-chat.cjs
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function getPythonBin(scriptPath) {
  const isWin = process.platform === 'win32';
  return process.env.SD_PYTHON_PATH ||
    (isWin
      ? path.join(path.dirname(scriptPath), 'venv', 'Scripts', 'python.exe')
      : path.join(path.dirname(scriptPath), 'venv', 'bin', 'python'));
}

function validatePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (trimmed.length < 5 || trimmed.length > 300) return false;
  if (/script|<|>|\{|\}|\[|\]|\$|\`|\"|\'|\//i.test(trimmed)) return false;
  return true;
}

module.exports = function({ app, openaiClient, uploadBufferToR2, detectImageIntent }) {
  app.post('/api/chat/dev', async (req, res) => {
    const userMessage = String(req.body?.message || '').trim();
    if (!userMessage) return res.status(400).json({ ok: false, error: 'missing_message' });

    // 1. Détection d’intention image
    if (detectImageIntent(userMessage)) {
      const prompt = userMessage.slice(0, 300);
      if (!validatePrompt(prompt)) {
        return res.status(400).json({ ok: false, error: 'invalid_prompt' });
      }
      const scriptPath = path.resolve(__dirname, '../../a11llm/scripts/generate_sd_image.py');
      if (!fs.existsSync(scriptPath)) {
        return res.status(500).json({ ok: false, error: 'missing_script' });
      }
      const pythonBin = getPythonBin(scriptPath);
      const { randomUUID } = require('crypto');
      const tempDir = path.join(process.cwd(), 'tmp', 'generated');
      fs.mkdirSync(tempDir, { recursive: true });
      const outputName = `sd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
      const outputPath = path.join(tempDir, outputName);
      const args = [scriptPath, '--prompt', prompt, '--output', outputPath];
      const py = spawn(pythonBin, args, { cwd: path.dirname(scriptPath) });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let finished = false;
      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          py.kill('SIGKILL');
          return res.status(504).json({ ok: false, error: 'timeout', message: 'Image generation timed out' });
        }
      }, 60000);
      py.stdout.on('data', (data) => { stdout = Buffer.concat([stdout, data]); });
      py.stderr.on('data', (data) => { stderr = Buffer.concat([stderr, data]); });
      py.on('close', async (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (code !== 0) {
          return res.status(500).json({ ok: false, error: 'python_failed', message: stderr.toString() });
        }
        let outputJson = null;
        try { outputJson = JSON.parse(stdout.toString()); } catch {
          return res.status(500).json({ ok: false, error: 'bad_python_output', raw: stdout.toString() });
        }
        if (!outputJson?.ok || !outputJson?.output_path || !fs.existsSync(outputJson.output_path)) {
          // LOGS DIAGNOSTIC AVANT no_image
          console.error('[no_image] stdout:', stdout.toString());
          console.error('[no_image] stderr:', stderr.toString());
          console.error('[no_image] outputJson:', outputJson);
          console.error('[no_image] output_path:', outputJson?.output_path);
          console.error('[no_image] existsSync:', outputJson?.output_path ? fs.existsSync(outputJson.output_path) : 'no path');
          return res.status(500).json({ ok: false, error: 'no_image', raw: outputJson });
        }
        try {
          const buffer = fs.readFileSync(outputJson.output_path);
          const filename = `sd_${Date.now()}.png`;
          const userId = req.user?.id || 'image-tool';
          const uploadResult = await uploadBufferToR2({
            userId, filename, buffer, contentType: 'image/png'
          });
          try { fs.unlinkSync(outputJson.output_path); } catch {}
          return res.json({
            ok: true,
            assistant: 'Image générée avec succès.',
            tool: 'generate_sd',
            artifact_type: 'image',
            image_url: uploadResult.url || null,
            filename,
            prompt
          });
        } catch (e) {
          return res.status(500).json({ ok: false, error: 'upload_failed', message: String(e?.message) });
        }
      });
      return;
    }

    // 2. Sinon, laisse le LLM répondre normalement
    if (!openaiClient) return res.status(500).json({ ok: false, error: 'llm_unavailable' });
    const completion = await openaiClient.chat.completions.create({
      model: process.env.A11_OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Tu es l’assistant A11 en mode DEV. Si la demande est une génération d’image, ne réponds pas en texte, laisse le routeur déclencher le tool.' },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 512
    });
    const text = completion?.choices?.[0]?.message?.content || '';
    return res.json({ ok: true, mode: 'llm', assistant: text });
  });
};
