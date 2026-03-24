// @ts-nocheck

// API Base URL for production (can be overridden via Vite env)
const API_BASE = (import.meta.env?.VITE_API_BASE_URL) || '';

// Router URL (can be overridden via Vite env)
const LLM_ROUTER_URL = (import.meta.env?.VITE_LLM_ROUTER_URL) || 'http://127.0.0.1:4545';

// Nezlephant token (optionnel)
const NEZ_TOKEN = (import.meta.env?.VITE_A11_NEZ_TOKEN) || '';

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
  const res = await fetch('/api/auth/login', {
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

export function logout() {
  clearAuthToken();
}

function dispatchBrowserEvent(event: Event) {
  globalThis.dispatchEvent(event);
}

export const TTS_API =
    import.meta.env.VITE_TTS_API ||
    (API_BASE ? `${API_BASE}/api/tts/piper` : '/api/tts/piper');

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
  const url = `${API_BASE}/api/ai`;

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
    const routerUrlObj = new URL(routerBase);
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
  systemPromptOrOptions?: string | { turbo?: boolean; systemPrompt?: string; a11Dev?: boolean; model?: string }
) {
  // Support both old signature (systemPrompt string) and new options object
  let systemPrompt: string | undefined;
  let turboFlag = false;
  let a11DevFlag = false;
  let modelOverride: string | undefined;
  if (typeof systemPromptOrOptions === 'string') {
    systemPrompt = systemPromptOrOptions;
  } else if (typeof systemPromptOrOptions === 'object' && systemPromptOrOptions !== null) {
    systemPrompt = systemPromptOrOptions.systemPrompt;
    turboFlag = !!systemPromptOrOptions.turbo;
    a11DevFlag = !!systemPromptOrOptions.a11Dev;
    modelOverride = systemPromptOrOptions.model;
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
    a11Dev: a11DevFlag // ← AJOUT ICI
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
    { role: 'system', content: systemPrompt || 'Tu es AlphaOnze (A-11), un assistant IA français unique et attachant.' },
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
  // On suppose que le backend écoute sur /api/tts/speak
  const fetchOptions: any = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  // same-origin proxy should include credentials
  fetchOptions.credentials = 'include';

  const url = API_BASE ? `${API_BASE}/api/tts/speak` : '/api/tts/speak';
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(devMode ? { messages, devMode } : { messages }),
  });
  if (!res.ok) {
    throw new Error(`A11 /api/agent error: ${res.status}`);
  }
  return res.json();
}

// === A11 Conversation History (backend) ===
export async function fetchA11HistoryList() {
  // GET /api/a11/history renvoie la liste des conversations (id, name, updated...)
  const url = API_BASE ? `${API_BASE}/api/a11/history` : '/api/a11/history';
  const res = await fetch(url);
  if (!res.ok) throw new Error('Erreur chargement historique A-11');
  return res.json();
}

export async function fetchA11Conversation(convId: string) {
  // GET /api/a11/history/:id renvoie les messages d'une conversation
  const url = API_BASE ? `${API_BASE}/api/a11/history/${encodeURIComponent(convId)}` : `/api/a11/history/${encodeURIComponent(convId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Erreur chargement conversation A-11');
  return res.json();
}
