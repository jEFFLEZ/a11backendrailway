const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream.transformToByteArray === 'function') {
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sanitizeFileName(name) {
  const base = String(name || '').trim() || 'file.bin';
  const cleaned = base.replaceAll(/[^a-zA-Z0-9._-]/g, '_').replaceAll(/_+/g, '_');
  return cleaned.slice(0, 180) || 'file.bin';
}

function normalizePublicAppUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) url = 'https://a11.funesterie.pro';
  url = url.replace(/^\/+/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

function createFileStorage(config = {}) {
  const r2Config = {
    endpoint: String(config.endpoint || '').trim(),
    accessKeyId: String(config.accessKeyId || '').trim(),
    secretAccessKey: String(config.secretAccessKey || '').trim(),
    bucket: String(config.bucket || '').trim(),
    publicBaseUrl: String(config.publicBaseUrl || '').trim(),
  };

  let clientSingleton = null;

  function isConfigured() {
    return !!(r2Config.endpoint && r2Config.accessKeyId && r2Config.secretAccessKey && r2Config.bucket);
  }

  function getClient() {
    if (clientSingleton) return clientSingleton;
    if (!isConfigured()) return null;

    clientSingleton = new S3Client({
      region: 'auto',
      endpoint: r2Config.endpoint,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });
    return clientSingleton;
  }

  function buildStorageKey(userId, filename) {
    const normalizedUserId = String(userId || 'anonymous').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    return `users/${normalizedUserId}/${Date.now()}-${sanitizeFileName(filename)}`;
  }

  function getPublicUrl(storageKey) {
    if (r2Config.publicBaseUrl) {
      return `${r2Config.publicBaseUrl.replace(/\/$/, '')}/${storageKey}`;
    }
    return `${r2Config.endpoint.replace(/\/$/, '')}/${r2Config.bucket}/${storageKey}`;
  }

  async function uploadBuffer({ userId, filename, buffer, contentType }) {
    const client = getClient();
    if (!client) {
      throw new Error('R2 is not configured');
    }

    const safeFilename = sanitizeFileName(filename);
    const storageKey = buildStorageKey(userId, safeFilename);
    await client.send(new PutObjectCommand({
      Bucket: r2Config.bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
    }));

    return {
      filename: safeFilename,
      storageKey,
      url: getPublicUrl(storageKey),
      contentType: contentType || 'application/octet-stream',
      sizeBytes: Buffer.isBuffer(buffer) ? buffer.length : Number(buffer?.length || 0),
    };
  }

  async function downloadBuffer(storageKey) {
    const client = getClient();
    if (!client) {
      throw new Error('R2 is not configured');
    }

    const normalizedStorageKey = String(storageKey || '').trim();
    if (!normalizedStorageKey) {
      throw new Error('missing_storage_key');
    }

    const response = await client.send(new GetObjectCommand({
      Bucket: r2Config.bucket,
      Key: normalizedStorageKey,
    }));

    return {
      buffer: await streamToBuffer(response.Body),
      contentType: String(response.ContentType || '').trim() || null,
      contentLength: Number(response.ContentLength || 0) || null,
      metadata: response.Metadata || null,
    };
  }

  async function deleteObject(storageKey) {
    const client = getClient();
    if (!client) {
      throw new Error('R2 is not configured');
    }

    const normalizedStorageKey = String(storageKey || '').trim();
    if (!normalizedStorageKey) {
      throw new Error('missing_storage_key');
    }

    await client.send(new DeleteObjectCommand({
      Bucket: r2Config.bucket,
      Key: normalizedStorageKey,
    }));

    return {
      ok: true,
      storageKey: normalizedStorageKey,
    };
  }

  return {
    isConfigured,
    getClient,
    buildStorageKey,
    getPublicUrl,
    uploadBuffer,
    downloadBuffer,
    deleteObject,
    sanitizeFileName,
    normalizePublicAppUrl,
  };
}

module.exports = {
  createFileStorage,
  sanitizeFileName,
  normalizePublicAppUrl,
};
