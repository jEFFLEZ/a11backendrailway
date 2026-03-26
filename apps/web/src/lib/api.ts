// @ts-nocheck

// API Base URL for production (can be overridden via Vite env)
const API_BASE = (import.meta.env?.VITE_API_BASE_URL) || (import.meta.env?.VITE_API_URL) || '';

function getApiUrl(path: string) {
  const base = API_BASE.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!base) return normalizedPath;
  if (base.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    return `${base}${normalizedPath.slice(4)}`;
  }
  if (base === '/api' && normalizedPath === '/api') {
    return base;
  }
  return `${base}${normalizedPath}`;
}

// Router URL (can be overridden via Vite env)
const LLM_ROUTER_URL = (import.meta.env?.VITE_LLM_ROUTER_URL) || 'http://127.0.0.1:4545';

// Nezlephant token (optionnel)
const NEZ_TOKEN = (import.meta.env?.VITE_A11_NEZ_TOKEN) || '';
const ADMIN_TOKEN = (import.meta.env?.VITE_A11_ADMIN_TOKEN) || '';

// ✅ AUTH HELPERS
export function getAuthToken() {
  return localStorage.getItem('a11-auth-token');
}

export function setAuthToken(token: string) {
  localStorage.setItem('a11-auth-token', token);
}

export function clearAuthToken() {
  localStorage.removeItem('a11-auth-token');
}

export async function login(username: string, password: string) {
  const res = await fetch(getApiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();
  if (data.success) {
    setAuthToken(data.token);
    return data;
  }
  throw new Error(data.error || 'Login failed');
}

export async function forgotPassword(email: string) {
  const res = await fetch(getApiUrl('/api/auth/forgot-password'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok) {
    throw new Error(data.error || `Forgot password failed (${res.status})`);
  }

  return data;
}

export async function resetPassword(token: string, password: string) {
  const res = await fetch(getApiUrl('/api/auth/reset-password'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password })
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok) {
    throw new Error(data.error || `Reset password failed (${res.status})`);
  }

  return data;
}

export function logout() {
  clearAuthToken();
}

function buildAuthHeaders(contentType?: string) {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

  const token = getAuthToken();
  if (token) headers['X-NEZ-TOKEN'] = token;
  else if (NEZ_TOKEN) headers['X-NEZ-TOKEN'] = NEZ_TOKEN;

  return headers;
}

function dispatchBrowserEvent(event: Event) {
  globalThis.dispatchEvent(event);
}

export const TTS_API =
  import.meta.env.VITE_TTS_API ||
  getApiUrl('/api/tts/piper');

export const TTS_VOICES = ['fr_FR-siwis-medium'];

export type Provider = "local" | "ollama" | "openai";

export function getModelForProvider(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'ollama':
      return 'llama3.2:latest';
    case 'local':
    default:
      return 'llama3.2:latest';
  }
}

export type Msg = { role: "user" | "assistant" | "system"; content: string };
export type ChatResponse = {
  choices?: { message?: { content?: string } }[];
  content?: string;
  output?: string;
};

// Appel générique POST JSON : pass via backend auth gateway
async function apiPost(body: unknown) {
  // Route through the protected backend chat endpoint.
  const url = getApiUrl('/api/ai');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  // ✅ Inject auth token if available
  const token = getAuthToken();
  if (token) headers['X-NEZ-TOKEN'] = token;
  else if (NEZ_TOKEN) headers['X-NEZ-TOKEN'] = NEZ_TOKEN;

  const fetchOptions: any = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  };

  // Use credentials for same-origin scenarios if router is same origin
  try {
    const routerUrlObj = new URL(LLM_ROUTER_URL);
    if (routerUrlObj.origin === location.origin) fetchOptions.credentials = 'include';
  } catch {
    // ignore
  }

  const res = await fetch(url, fetchOptions);

  // If response is an event-stream, process incrementally
  const contentType = res.headers.get('content-type') || '';
  if (res.ok && (contentType.includes('text/event-stream') || contentType.includes('text/plain'))) {
    // Try to stream-process SSE-style responses
    try {
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buf = '';
        let aggregated = '';

        // Helper to process a full line starting with 'data:'
        const processDataLine = (line) => {
          const payload = line.slice(5).trim(); // after 'data:'
          if (!payload) return;
          if (payload === '[DONE]') {
            dispatchBrowserEvent(new CustomEvent('a11:assistant.done'));
            return;
          }
          let parsed = null;
          try { parsed = JSON.parse(payload); } catch { return; }
          const chunk = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? parsed?.response ?? '';
          if (chunk) {
            aggregated += String(chunk);
            dispatchBrowserEvent(new CustomEvent('a11:assistant.delta', { detail: String(chunk) }));
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          // split on double-newline which typically separates SSE events
          let parts = buf.split(/\n\n/);
          // keep last partial in buffer
          buf = parts.pop() || '';

          for (const p of parts) {
            const lines = p.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
              if (line.startsWith('data:')) {
                // Log raw data for debugging
                console.log('[A11][RAW] 200 data:', line.slice(5).trim());
                processDataLine(line);
              }
            }
          }
        }

        // Final flush if buffer contains a data: line
        const finalLines = buf.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of finalLines) {
          if (line.startsWith('data:')) {
            console.log('[A11][RAW] 200 data:', line.slice(5).trim());
            processDataLine(line);
          }
        }

        // Return OpenAI-like structure with aggregated content
        return {
          choices: [{ message: { role: 'assistant', content: aggregated } }]
        };
      }
    } catch (error_) {
      console.warn('[A11][STREAM] streaming parse failed, falling back to full read', error_);
      // fallthrough to full-text handling
    }
  }

  // Try streaming text if needed; for now read full text
  const text = await res.text();
  console.log('[A11][RAW]', res.status, text);

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text}`);
  }

  let data: any;
  try {
    // Handle event-stream / SSE style responses that prefix lines with "data: {...}"
    const trimmed = text.trim();
    if (trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
      // Extract JSON blobs from lines starting with 'data: '
      const re = /data:\s*(\{[\s\S]*?\})(?:\s*\n|$)/g;
      let match: RegExpExecArray | null;
      let lastJsonStr: string | null = null;
      const parts: string[] = [];
      while ((match = re.exec(text)) !== null) {
        lastJsonStr = match[1];
        try {
          const parsed = JSON.parse(lastJsonStr);
          const chunk = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? parsed?.response ?? null;
          if (chunk) parts.push(String(chunk));
        } catch {
          // ignore
        }
      }
      if (parts.length) {
        data = { choices: [{ message: { role: 'assistant', content: parts.join('') } }] };
      } else if (lastJsonStr) {
        try { data = JSON.parse(lastJsonStr); } catch { data = { raw: text }; }
      } else {
        data = { raw: text };
      }
    } else {
      data = JSON.parse(text);
    }
  } catch {
    // If parsing fails, return raw text wrapped
    if (!data) data = { raw: text };
  }

  return data;
}

// Appel OpenAI-like, now accepts provider
export async function chatCompletion(
  messages: Msg[],
  provider: Provider = 'local',
  systemPromptOrOptions?: string | { turbo?: boolean; systemPrompt?: string; a11Dev?: boolean; model?: string; conversationId?: string }
) {
  // Support both old signature (systemPrompt string) and new options object
  let systemPrompt: string | undefined;
  let turboFlag = false;
  let a11DevFlag = false;
  let modelOverride: string | undefined;
  let conversationId: string | undefined;
  if (typeof systemPromptOrOptions === 'string') {
    systemPrompt = systemPromptOrOptions;
  } else if (typeof systemPromptOrOptions === 'object' && systemPromptOrOptions !== null) {
    systemPrompt = systemPromptOrOptions.systemPrompt;
    turboFlag = !!systemPromptOrOptions.turbo;
    a11DevFlag = !!systemPromptOrOptions.a11Dev;
    modelOverride = systemPromptOrOptions.model;
    conversationId = typeof systemPromptOrOptions.conversationId === 'string'
      ? systemPromptOrOptions.conversationId.trim()
      : undefined;
  }

  // Ajout du systemPrompt si fourni
  let msgs = messages;
  if (systemPrompt) {
    msgs = [{ role: 'system', content: systemPrompt }, ...messages.filter(m => m.role !== 'system')];
  }

  // Filtre les tokens spéciaux Llama (<|...|>) dans tous les messages
  msgs = msgs.map(m => ({
    ...m,
    content: typeof m.content === 'string' ? m.content.replaceAll(/<\|.*?\|>/g, '') : ''
  }));

  const payload = {
    provider,
    model: modelOverride || getModelForProvider(provider),
    messages: msgs,
    stream: false,
    temperature: turboFlag ? 0.3 : 0.7,
    top_p: 0.9,
    a11Dev: a11DevFlag,
    conversationId,
  };

  // Always post to router (apiPost ignores the path and uses router endpoint)
  const data = await apiPost(payload);

  // On essaie de lire réponse façon OpenAI
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.reply ??
    JSON.stringify(data);

  return content as string;
}

// Chat simple avec prompt système et modèle choisis
export async function chat(message: string, history: Msg[] = [], provider: Provider = 'local', systemPrompt?: string) {
  const messages: Msg[] = history.length ? history : [
    { role: 'system', content: systemPrompt || "Tu es A-11, assistant local. Reponds court, clair et direct. N'invente pas de contexte. Ne propose pas d'action non demandee. Si la question est triviale, reponds en une phrase maximum." },
    { role: 'user', content: message }
  ];
  dispatchBrowserEvent(new Event('conversation:start'));
  try {
    return await chatCompletion(messages, provider, systemPrompt);
  } finally {
    dispatchBrowserEvent(new Event('conversation:end'));
  }
}

// Appel TTS générique
export async function ttsSpeak(text: string, voice: string = 'fr_FR-siwis-medium', provider: string = 'piper') {
  const payload = {
    text,
    voice,
    provider
  };
  // Backend route is mounted at /api/tts/piper
  const fetchOptions: any = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  // same-origin proxy should include credentials
  fetchOptions.credentials = 'include';

  const url = API_BASE ? `${API_BASE}/api/tts/piper` : '/api/tts/piper';
  const res = await fetch(url, fetchOptions);

  // Si le backend renvoie JSON (erreur ou métadonnées)
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    // essayer de parser JSON d'erreur
    if (contentType.includes('application/json')) {
      const err = await res.json();
      throw new Error(err?.error ? String(err.error) : JSON.stringify(err));
    }
    const textErr = await res.text();
    throw new Error(textErr || `TTS request failed with status ${res.status}`);
  }

  // Si audio retourné, renvoyer une URL blob exploitable par le frontend
  if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
    const blob = await res.blob();
    const audioUrl = URL.createObjectURL(blob);
    return { success: true, audioUrl, blob };
  }

  // Sinon on essaie le JSON (cas ElevenLabs / fallback)
  try {
    const data = await res.json();
    return data;
  } catch {
    // fallback: retourner le texte brut
    const txt = await res.text();
    return { success: true, text: txt };
  }
}

export type A11ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type A11HistoryItem = {
  id: string;
  name: string;
  updated?: string;
  messageCount?: number;
};

export type A11ConversationResource = {
  id?: number;
  userId?: string;
  conversationId?: string | null;
  resourceKind?: string;
  origin?: string;
  filename: string;
  storageKey?: string;
  url?: string;
  contentType?: string;
  sizeBytes?: number;
  metadata?: any;
  createdAt?: string;
  updatedAt?: string;
};

export type A11ConversationActivityEntry = {
  id: string;
  type: string;
  tone?: string;
  ts?: string;
  title: string;
  summary: string;
  detail?: string;
};

export type A11AgentResponse =
  | {
      type: "text";
      content: string;
    }
  | {
      type: "tool-result";
      tool: string;
      input: any;
      result: any;
      explanation: string;
      imageUrl?: string | null;
      actionId?: string | null;
    }
  | {
      type: "tool-error";
      tool: string;
      input: any;
      error: string;
      actionId?: string | null;
    };

export async function callA11Agent(messages: A11ChatMessage[], devMode?: boolean): Promise<A11AgentResponse> {
  const url = API_BASE ? `${API_BASE}/api/agent` : "/api/agent";
  const res = await fetch(url, {
    method: "POST",
    headers: buildAuthHeaders("application/json"),
    body: JSON.stringify(devMode ? { messages, devMode, allowDevActions: true } : { messages }),
  });
  if (!res.ok) {
    throw new Error(`A11 /api/agent error: ${res.status}`);
  }
  const data = await res.json();
  if (data?.mode === "text") {
    return {
      type: "text",
      content: String(data.text || data.explanation || ""),
    };
  }
  return {
    type: "tool-result",
    tool: "actions",
    input: data?.envelope || null,
    result: data?.cerbere || null,
    explanation: String(data?.explanation || ""),
    imageUrl: data?.imagePath || null,
    actionId: null,
  };
}

// === A11 Conversation History (backend) ===
export async function fetchA11HistoryList() {
  // GET /api/a11/history renvoie la liste des conversations (id, name, updated...)
  const url = API_BASE ? `${API_BASE}/api/a11/history` : '/api/a11/history';
  const res = await fetch(url, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) throw new Error('Erreur chargement historique A-11');
  return res.json() as Promise<A11HistoryItem[]>;
}

export async function fetchA11Conversation(convId: string) {
  // GET /api/a11/history/:id renvoie les messages d'une conversation
  const url = API_BASE ? `${API_BASE}/api/a11/history/${encodeURIComponent(convId)}` : `/api/a11/history/${encodeURIComponent(convId)}`;
  const res = await fetch(url, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) throw new Error('Erreur chargement conversation A-11');
  return res.json();
}

export async function fetchA11ConversationResources(convId: string, options?: { kind?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (options?.kind) params.set('kind', options.kind);
  if (options?.limit) params.set('limit', String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const url = API_BASE
    ? `${API_BASE}/api/a11/history/${encodeURIComponent(convId)}/resources${suffix}`
    : `/api/a11/history/${encodeURIComponent(convId)}/resources${suffix}`;
  const res = await fetch(url, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) throw new Error('Erreur chargement ressources A-11');
  return res.json();
}

export async function fetchA11ConversationActivity(convId: string, options?: { limit?: number }) {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const url = API_BASE
    ? `${API_BASE}/api/a11/history/${encodeURIComponent(convId)}/activity${suffix}`
    : `/api/a11/history/${encodeURIComponent(convId)}/activity${suffix}`;
  const res = await fetch(url, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) throw new Error('Erreur chargement activite A-11');
  return res.json() as Promise<{
    ok: boolean;
    conversationId?: string | null;
    count?: number;
    entries?: A11ConversationActivityEntry[];
  }>;
}

function encodeTextAsDataUrl(text: string, contentType = 'text/plain;charset=utf-8') {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${contentType};base64,${base64}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('file_read_failed'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

export async function uploadConversationFile(file: File, options?: { conversationId?: string; emailTo?: string }) {
  const contentBase64 = await readFileAsDataUrl(file);
  const res = await fetch(getApiUrl('/api/files/upload'), {
    method: 'POST',
    headers: buildAuthHeaders('application/json'),
    body: JSON.stringify({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      contentBase64,
      conversationId: options?.conversationId,
      emailTo: options?.emailTo,
    }),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse error
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || data?.error || `Upload failed (${res.status})`);
  }

  return data as {
    ok: boolean;
    conversationId?: string;
    file?: A11ConversationResource;
    conversationResource?: A11ConversationResource | null;
    record?: any;
    mail?: any;
  };
}

export async function createTextArtifact(options: {
  filename: string;
  text: string;
  contentType?: string;
  kind?: string;
  conversationId?: string;
  description?: string;
  emailTo?: string;
  emailSubject?: string;
  emailMessage?: string;
  attachToEmail?: boolean;
}) {
  const contentType = String(options.contentType || 'text/plain;charset=utf-8').trim() || 'text/plain;charset=utf-8';
  const contentBase64 = encodeTextAsDataUrl(options.text, contentType);
  const res = await fetch(getApiUrl('/api/artifacts/create'), {
    method: 'POST',
    headers: buildAuthHeaders('application/json'),
    body: JSON.stringify({
      filename: options.filename,
      contentBase64,
      contentType,
      kind: options.kind,
      conversationId: options.conversationId,
      description: options.description,
      emailTo: options.emailTo,
      emailSubject: options.emailSubject,
      emailMessage: options.emailMessage,
      attachToEmail: !!options.attachToEmail,
    }),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse error
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || data?.error || `Artifact creation failed (${res.status})`);
  }

  return data as {
    ok: boolean;
    artifact?: {
      kind?: string;
      conversationId?: string;
      description?: string | null;
      filename?: string;
      storageKey?: string;
      url?: string;
      contentType?: string;
      sizeBytes?: number;
    };
    record?: any;
    mail?: any;
    conversationResource?: A11ConversationResource | null;
  };
}

export async function emailConversationResource(resourceId: number, options: { to: string; subject?: string; message?: string; attachToEmail?: boolean }) {
  const res = await fetch(getApiUrl('/api/resources/email'), {
    method: 'POST',
    headers: buildAuthHeaders('application/json'),
    body: JSON.stringify({
      resourceId,
      to: options.to,
      subject: options.subject,
      message: options.message,
      attachToEmail: !!options.attachToEmail,
    }),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse error
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || data?.error || `Resource email failed (${res.status})`);
  }

  return data as {
    ok: boolean;
    resourceId: number;
    resource?: A11ConversationResource;
    mail?: {
      ok?: boolean;
      id?: string | null;
      to?: string;
      subject?: string;
      attachmentIncluded?: boolean;
      attachmentFallbackReason?: string | null;
    };
  };
}

function parseDownloadFilename(contentDisposition: string, fallback: string) {
  const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition || '');
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      // ignore malformed encoding
    }
  }

  const quotedMatch = /filename="([^"]+)"/i.exec(contentDisposition || '');
  if (quotedMatch?.[1]) return quotedMatch[1];

  const plainMatch = /filename=([^;]+)/i.exec(contentDisposition || '');
  if (plainMatch?.[1]) return plainMatch[1].trim();

  return fallback;
}

export async function downloadConversationResource(resource: A11ConversationResource) {
  const resourceId = Number(resource?.id || 0);
  if (!Number.isFinite(resourceId) || resourceId <= 0) {
    throw new Error('invalid_resource_id');
  }

  const res = await fetch(getApiUrl(`/api/resources/${resourceId}/download`), {
    method: 'GET',
    headers: buildAuthHeaders(),
  });

  if (!res.ok) {
    let data: any = {};
    try {
      data = await res.json();
    } catch {
      // ignore parse errors
    }
    throw new Error(data?.message || data?.error || `Resource download failed (${res.status})`);
  }

  const blob = await res.blob();
  const fallbackName = String(resource.filename || `resource-${resourceId}.bin`);
  const filename = parseDownloadFilename(res.headers.get('content-disposition') || '', fallbackName);
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

  return {
    ok: true,
    filename,
    sizeBytes: blob.size,
  };
}

type MemoryCounts = {
  facts: number;
  tasks: number;
  files: number;
};

export type MemoryPurgeNowResponse = {
  ok: boolean;
  userId: string;
  dryRun?: boolean;
  purgeTriggeredAt: string;
  before: MemoryCounts;
  after: MemoryCounts;
  removed: MemoryCounts;
  wouldRemove?: MemoryCounts | null;
};

export type A11HostStatusResponse = {
  ok: boolean;
  available?: boolean;
  bridgeAvailable?: boolean;
  headlessAvailable?: boolean;
  mode?: string;
  safeMode?: boolean;
  workspaceRoot?: string | null;
  buildCommandConfigured?: boolean;
  methods?: string[];
  bridgeMethods?: string[];
  headlessMethods?: string[];
  capabilities?: Record<string, boolean>;
  shellPolicy?: {
    whitelisted?: boolean;
    defaultExamples?: string[];
    extraPrefixes?: string[];
  };
  error?: string;
};

export type A11CapabilitiesResponse = {
  ok: boolean;
  a11host?: {
    mode?: string;
    bridgeConnected?: boolean;
    safeMode?: boolean;
    workspaceRoot?: string | null;
    shellCwd?: string | null;
    buildCommand?: string | null;
    buildCommandConfigured?: boolean;
    methods?: {
      active?: string[];
      bridge?: string[];
      headless?: string[];
    };
    capabilities?: Record<string, boolean>;
    shellPolicy?: {
      whitelisted?: boolean;
      defaultExamples?: string[];
      extraPrefixes?: string[];
    };
  };
  qflush?: {
    available?: boolean;
    error?: string | null;
    processes?: Record<string, {
      status?: string;
      pid?: number | null;
      restarts?: number;
      uptime?: string | number | null;
    }>;
  };
  error?: string;
};

export type QflushStatusResponse = {
  available?: boolean;
  initialized?: boolean;
  remoteUrl?: string | null;
  chatFlow?: string | null;
  memorySummaryFlow?: string | null;
  memorySummaryBuiltIn?: boolean;
  message?: string;
  error?: string;
  processes?: Record<string, {
    status?: string;
    pid?: number | null;
    restarts?: number;
    uptime?: string | number | null;
  }>;
};

export async function fetchA11HostStatus(): Promise<A11HostStatusResponse> {
  const res = await fetch(getApiUrl('/api/a11host/status'), {
    headers: buildAuthHeaders(),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse errors
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `A11Host status failed (${res.status})`);
  }

  return data as A11HostStatusResponse;
}

export async function fetchA11Capabilities(): Promise<A11CapabilitiesResponse> {
  const res = await fetch(getApiUrl('/api/a11/capabilities'), {
    headers: buildAuthHeaders(),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse errors
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `A11 capabilities failed (${res.status})`);
  }

  return data as A11CapabilitiesResponse;
}

export async function fetchQflushStatus(): Promise<QflushStatusResponse> {
  const res = await fetch(getApiUrl('/api/qflush/status'), {
    headers: buildAuthHeaders(),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse errors
  }

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Qflush status failed (${res.status})`);
  }

  return data as QflushStatusResponse;
}

export async function purgeMemoryNow(options?: { userId?: string; dryRun?: boolean }): Promise<MemoryPurgeNowResponse> {
  const dryRun = !!options?.dryRun;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const token = getAuthToken();
  if (token) headers['X-NEZ-TOKEN'] = token;
  else if (NEZ_TOKEN) headers['X-NEZ-TOKEN'] = NEZ_TOKEN;

  if (ADMIN_TOKEN) headers['X-NEZ-ADMIN'] = ADMIN_TOKEN;

  const purgePath = dryRun ? '/api/memory/purge-now?dryRun=1' : '/api/memory/purge-now';
  const res = await fetch(getApiUrl(purgePath), {
    method: 'POST',
    headers,
    body: JSON.stringify(options?.userId ? { userId: options.userId } : {}),
  });

  let data: any = {};
  try {
    data = await res.json();
  } catch {
    // ignore parse errors and use fallback error below
  }

  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || data?.error || `Memory purge failed (${res.status})`);
  }

  return data as MemoryPurgeNowResponse;
}
