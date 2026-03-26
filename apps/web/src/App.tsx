import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  createTextArtifact,
  downloadConversationResource,
  fetchA11HistoryList,
  fetchA11Conversation,
  fetchA11ConversationActivity,
  fetchA11ConversationResources,
  emailConversationResource,
  login,
  logout,
  getAuthToken,
  register,
  forgotPassword,
  resetPassword,
  purgeMemoryNow,
  uploadConversationFile,
  type A11ConversationActivityEntry,
  type A11ConversationResource,
  type A11HistoryItem,
} from "./lib/api";
import { A11HistoryPanel } from "./components/A11HistoryPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { A11OpsStatusPanel } from "./components/A11OpsStatusPanel";
import { A11VsixDebugPanel } from "./components/A11VsixDebugPanel";
import { ConversationActivityPanel } from "./components/ConversationActivityPanel";
import { ConversationResourcesPanel } from "./components/ConversationResourcesPanel";
import { CreateArtifactModal } from "./components/CreateArtifactModal";
import { EmailResourceModal } from "./components/EmailResourceModal";
import { ConfirmModal } from "./components/ConfirmModal";
import { RenameConversationModal } from "./components/RenameConversationModal";
import ReactMarkdown from "react-markdown";
import "./index.css";
import {
  initSpeech,
  startMic,
  stopMic,
  speak,
  cancelSpeech,
  setTtsQueueEnabled,
  setSpeechMuted,
  isSpeechMuted,
  retryPlayUrl,
} from "./lib/speech";
import handleImportFiles from "./lib/importer";
import { chatCompletion, type Provider } from "./lib/api";

type Role = "user" | "assistant" | "system";

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  imageUrl?: string | null;
}

interface PurgeHistoryEntry {
  at: string;
  dryRun: boolean;
  removed: { facts: number; tasks: number; files: number };
}

interface LlmStats {
  ok: boolean;
  backend?: string;
  model?: string;
  mode?: string;
  gpu?: boolean;
}

type A11HistoryMessage = {
  id?: string;
  role: Role;
  content: string;
  ts?: string;
  imageUrl?: string | null;
};

type ArtifactFormat = "markdown" | "text" | "json";

type AssistantExportSuggestion = {
  kind: string;
  label: string;
  hint: string;
  fileStem: string;
  accent: string;
};

const DEFAULT_SYSTEM_NINDO =
  "Tu es A-11, assistant local. Réponds de façon concise, claire et directe. N'invente pas de contexte. Ne fais aucune action et ne proposes aucune action non demandée explicitement. Si la question est triviale, réponds en une phrase maximum.";

function buildConversationArtifactContent(
  conversationMessages: ChatMessage[],
  options: { conversationId?: string | null; format: ArtifactFormat }
) {
  const exportedAt = new Date().toISOString();
  const conversationId = String(options.conversationId || "default").trim() || "default";
  const visibleMessages = conversationMessages.filter((message) => message.role !== "system");
  const messagesToExport = visibleMessages.length ? visibleMessages : conversationMessages;
  const normalizedMessages = messagesToExport.map((message, index) => ({
    index: index + 1,
    role: message.role,
    content: String(message.content || ""),
    imageUrl: message.imageUrl || null,
  }));

  if (options.format === "json") {
    return {
      kind: "conversation_json",
      contentType: "application/json;charset=utf-8",
      text: JSON.stringify(
        {
          conversationId,
          exportedAt,
          messageCount: normalizedMessages.length,
          messages: normalizedMessages,
        },
        null,
        2
      ),
    };
  }

  if (options.format === "markdown") {
    const lines = [
      "# Export A11",
      "",
      `- Conversation: ${conversationId}`,
      `- Exported at: ${exportedAt}`,
      `- Messages: ${normalizedMessages.length}`,
      "",
    ];

    for (const message of normalizedMessages) {
      lines.push(`## ${message.role.toUpperCase()} ${message.index}`);
      lines.push("");
      lines.push(message.content || "_Message vide_");
      if (message.imageUrl) {
        lines.push("");
        lines.push(`Image: ${message.imageUrl}`);
      }
      lines.push("");
    }

    return {
      kind: "conversation_markdown",
      contentType: "text/markdown;charset=utf-8",
      text: lines.join("\n"),
    };
  }

  const lines = [
    "A11 Conversation Export",
    `Conversation: ${conversationId}`,
    `Exported at: ${exportedAt}`,
    `Messages: ${normalizedMessages.length}`,
    "",
  ];

  for (const message of normalizedMessages) {
    lines.push(`[${message.role.toUpperCase()} #${message.index}]`);
    lines.push(message.content || "(message vide)");
    if (message.imageUrl) lines.push(`Image: ${message.imageUrl}`);
    lines.push("");
  }

  return {
    kind: "conversation_text",
    contentType: "text/plain;charset=utf-8",
    text: lines.join("\n"),
  };
}

function slugifyArtifactSegment(value: string | null | undefined, fallback: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function detectAssistantExportSuggestion(content: string): AssistantExportSuggestion | null {
  const text = String(content || "").trim();
  if (!text) return null;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bulletCount = lines.filter((line) => /^([-*]|\d+\.)\s+/.test(line)).length;
  const headingCount = lines.filter((line) => /^#{1,3}\s+/.test(line)).length;
  const tableLike = lines.filter((line) => /\|/.test(line)).length >= 3;
  const jsonLike = text.startsWith("{") || text.startsWith("[") || text.includes("```json");
  const codeLike = text.includes("```");

  if (jsonLike) {
    return {
      kind: "structured_json",
      label: "JSON",
      hint: "Resultat structure detecte, pratique a exporter ou reutiliser.",
      fileStem: "json",
      accent: "#38bdf8",
    };
  }

  if (tableLike) {
    return {
      kind: "tabular_result",
      label: "Tableau",
      hint: "Donnees tabulaires detectees, utiles a conserver comme document.",
      fileStem: "tableau",
      accent: "#22c55e",
    };
  }

  if (codeLike) {
    return {
      kind: "code_snippet",
      label: "Code",
      hint: "Bloc de code detecte, utile a sauvegarder comme artefact.",
      fileStem: "code",
      accent: "#a78bfa",
    };
  }

  if (bulletCount >= 4) {
    return {
      kind: "structured_list",
      label: "Liste",
      hint: "Liste ou plan detecte, pret a etre exporte.",
      fileStem: "liste",
      accent: "#f59e0b",
    };
  }

  if (headingCount >= 2 || text.length >= 900) {
    return {
      kind: "structured_document",
      label: "Document",
      hint: "Contenu long ou structure, pertinent pour un export.",
      fileStem: "document",
      accent: "#f97316",
    };
  }

  return null;
}

function buildAssistantMessageArtifact(message: ChatMessage, options: { conversationId?: string | null; index: number }) {
  const exportedAt = new Date().toISOString();
  const conversationId = String(options.conversationId || "default").trim() || "default";
  const suggestion = detectAssistantExportSuggestion(message.content);
  const lines = [
    `# ${suggestion ? `Resultat A11 - ${suggestion.label}` : "Reponse A11"}`,
    "",
    `- Conversation: ${conversationId}`,
    `- Exported at: ${exportedAt}`,
    `- Message index: ${options.index + 1}`,
    "",
    message.content || "_Reponse vide_",
  ];

  if (message.imageUrl) {
    lines.push("");
    lines.push(`Image: ${message.imageUrl}`);
  }

  const dateLabel = exportedAt.slice(0, 10);
  const filename = `a11-${slugifyArtifactSegment(conversationId, "conversation")}-${slugifyArtifactSegment(suggestion?.fileStem, "reply")}-${dateLabel}-${options.index + 1}.md`;
  return {
    filename,
    kind: suggestion?.kind || "assistant_reply",
    contentType: "text/markdown;charset=utf-8",
    description: suggestion
      ? `${suggestion.label} exporte depuis ${conversationId}`
      : `Reponse assistant exportee depuis ${conversationId}`,
    text: lines.join("\n"),
  };
}
// ✅ LOGIN PANEL
function LoginPanel({ onLoginSuccess }: { onLoginSuccess: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [username, setUsername] = useState("Djeff");
  const [registerEmail, setRegisterEmail] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [password, setPassword] = useState("1991");
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [forgotError, setForgotError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);

  const switchMode = (nextMode: "login" | "register" | "forgot") => {
    setMode(nextMode);
    setError("");
    setForgotError("");
    setForgotSent(false);
    setInfo("");
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setLoading(true);
    try {
      await login(username, password);
      onLoginSuccess();
    } catch (err) {
      setError((err as Error).message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!username.trim() || !registerEmail.trim() || !password) {
      setError("Pseudo, email et mot de passe requis");
      return;
    }
    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas");
      return;
    }
    setLoading(true);
    try {
      const result = await register(username.trim(), registerEmail.trim(), password);
      if (result?.token) {
        onLoginSuccess();
        return;
      }
      setInfo("Compte cree. Connecte-toi avec ton nouveau mot de passe.");
      setMode("login");
    } catch (err) {
      setError((err as Error).message || "Inscription echouee");
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setInfo("");
    setForgotError("");
    setForgotSent(false);
    if (!forgotEmail.trim()) {
      setForgotError("Email requis");
      return;
    }
    setForgotLoading(true);
    try {
      await forgotPassword(forgotEmail.trim());
      setForgotSent(true);
    } catch (err) {
      setForgotError((err as Error).message || "Erreur forgot password");
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "20px" }}>
      <h1>🔐 A-11 Login</h1>
      <div style={{ display: "flex", gap: "10px", marginBottom: "8px" }}>
        <button
          type="button"
          onClick={() => switchMode("login")}
          style={{
            padding: "10px 16px",
            borderRadius: "999px",
            border: "1px solid #334155",
            background: mode === "login" ? "#7c3aed" : "#0f172a",
            color: "white",
            cursor: "pointer",
            fontWeight: "bold"
          }}
        >
          Login
        </button>
        <button
          type="button"
          onClick={() => switchMode("register")}
          style={{
            padding: "10px 16px",
            borderRadius: "999px",
            border: "1px solid #334155",
            background: mode === "register" ? "#7c3aed" : "#0f172a",
            color: "white",
            cursor: "pointer",
            fontWeight: "bold"
          }}
        >
          S'inscrire
        </button>
        <button
          type="button"
          onClick={() => switchMode("forgot")}
          style={{
            padding: "10px 16px",
            borderRadius: "999px",
            border: "1px solid #334155",
            background: mode === "forgot" ? "#7c3aed" : "#0f172a",
            color: "white",
            cursor: "pointer",
            fontWeight: "bold"
          }}
        >
          Reset
        </button>
      </div>
      {mode === "login" && (
        <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "15px", minWidth: "300px" }}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "10px 20px",
              borderRadius: "4px",
              border: "none",
              background: "#007bff",
              color: "white",
              cursor: "pointer",
              fontWeight: "bold"
            }}
          >
            {loading ? "Logging in..." : "Login"}
          </button>
        </form>
      )}
      {mode === "register" && (
        <form onSubmit={handleRegister} style={{ display: "flex", flexDirection: "column", gap: "15px", minWidth: "300px" }}>
          <input
            type="text"
            placeholder="Pseudo"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <input
            type="email"
            placeholder="Email"
            value={registerEmail}
            onChange={(e) => setRegisterEmail(e.target.value)}
            disabled={loading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <input
            type="password"
            placeholder="Confirmer le mot de passe"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={loading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: "10px 20px",
              borderRadius: "4px",
              border: "none",
              background: "#7c3aed",
              color: "white",
              cursor: "pointer",
              fontWeight: "bold"
            }}
          >
            {loading ? "Creation..." : "S'inscrire"}
          </button>
        </form>
      )}
      {mode === "forgot" && (
        <form onSubmit={handleForgot} style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "300px", marginTop: "10px" }}>
          <div style={{ fontSize: "13px", color: "#94a3b8" }}>Mot de passe oublié ?</div>
          <input
            type="email"
            placeholder="Ton email"
            value={forgotEmail}
            onChange={(e) => setForgotEmail(e.target.value)}
            disabled={forgotLoading}
            style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
          />
          <button
            type="submit"
            disabled={forgotLoading}
            style={{
              padding: "10px 20px",
              borderRadius: "4px",
              border: "1px solid #334155",
              background: "#0f172a",
              color: "#e2e8f0",
              cursor: "pointer",
              fontWeight: "bold"
            }}
          >
            {forgotLoading ? "Envoi..." : "Envoyer le lien de reset"}
          </button>
          {forgotError && <div style={{ color: "red", fontSize: "13px" }}>{forgotError}</div>}
          {forgotSent && <div style={{ color: "#22c55e", fontSize: "13px" }}>Si l'email existe, un lien a ete envoye.</div>}
        </form>
      )}
      {error && <div style={{ color: "red", fontSize: "14px", maxWidth: "320px", textAlign: "center" }}>{error}</div>}
      {info && <div style={{ color: "#22c55e", fontSize: "14px", maxWidth: "320px", textAlign: "center" }}>{info}</div>}
      <p style={{ fontSize: "12px", color: "#999" }}>Admin: Djeff / 1991</p>
    </div>
  );
}

function ResetPasswordPanel() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const token = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('token') || '';
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!token) {
      setError("Token manquant dans l'URL");
      return;
    }
    if (password.length < 4) {
      setError("Mot de passe trop court");
      return;
    }
    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas");
      return;
    }

    setLoading(true);
    try {
      await resetPassword(token, password);
      setSuccess(true);
    } catch (err) {
      setError((err as Error).message || "Reset impossible");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100vh", gap: "20px" }}>
      <h1>Reset Password</h1>
      <form onSubmit={handleReset} style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: "320px" }}>
        <input
          type="password"
          placeholder="Nouveau mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
        />
        <input
          type="password"
          placeholder="Confirmer le mot de passe"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={loading}
          style={{ padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px 20px",
            borderRadius: "4px",
            border: "none",
            background: "#16a34a",
            color: "white",
            cursor: "pointer",
            fontWeight: "bold"
          }}
        >
          {loading ? "Reset..." : "Valider"}
        </button>
        {error && <div style={{ color: "red", fontSize: "14px" }}>{error}</div>}
        {success && (
          <div style={{ color: "#22c55e", fontSize: "14px" }}>
            Mot de passe modifie. Tu peux revenir sur la page de login.
          </div>
        )}
      </form>
    </div>
  );
}
// MuteButton : icône seule, contrôle global du son
function MuteButton() {
  const [muted, setMuted] = useState(isSpeechMuted());

  useEffect(() => {
    try {
      const saved = localStorage.getItem('a11:muted');
      if (saved === '1') setMuted(true);
    } catch {
      // ignore storage access errors
    }
  }, []);

  useEffect(() => {
    setSpeechMuted(muted);
    if (muted) {
      cancelSpeech();
    }

    try {
      localStorage.setItem('a11:muted', muted ? '1' : '0');
    } catch {
      // ignore storage access errors
    }
  }, [muted]);

  return (
    <button
      onClick={() => setMuted(m => !m)}
      title={muted ? "Rétablir la voix d'A11" : "Couper la voix d'A11"}
      style={{ fontSize: 20, padding: 6, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      className="btn ghost"
    >
      {muted ? (
        <span role="img" aria-label="Audio coupé">🔇</span>
      ) : (
        <span role="img" aria-label="Audio actif">🔊</span>
      )}
    </button>
  );
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isResetRoute, setIsResetRoute] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "sys-1",
      role: "system",
      content: DEFAULT_SYSTEM_NINDO,
    },
  ]);
  const [ttsFallback, setTtsFallback] = useState(false);
  const [audioBlockedUrl, setAudioBlockedUrl] = useState<string | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);

  // Audio-blocked banner: listen for autoplay block events
  useEffect(() => {
    const onBlocked = (e: Event) => {
      const url = (e as CustomEvent).detail?.url;
      if (url) setAudioBlockedUrl(url);
    };
    const onSpeechStart = () => {
      setAudioBlockedUrl(null);
      setAudioPlaying(true);
    };
    const onSpeechEnd = () => setAudioPlaying(false);
    globalThis.addEventListener('a11:audioBlocked', onBlocked);
    globalThis.addEventListener('a11:speechstart', onSpeechStart);
    globalThis.addEventListener('a11:speechend', onSpeechEnd);
    return () => {
      globalThis.removeEventListener('a11:audioBlocked', onBlocked);
      globalThis.removeEventListener('a11:speechstart', onSpeechStart);
      globalThis.removeEventListener('a11:speechend', onSpeechEnd);
    };
  }, []);

  // Check if already authenticated on mount
  useEffect(() => {
    const token = getAuthToken();
    if (token) {
      setIsAuthenticated(true);
    }
    const pathname = window.location.pathname.toLowerCase();
    setIsResetRoute(pathname.includes('/reset-password') || pathname.includes('/reset'));
  }, []);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const stats: LlmStats | null = null;
  const [voiceListening, setVoiceListening] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toggleLockRef = useRef(false);
  const [model, setModel] = useState("gpt-4o-mini");

  // Chats state persisted in localStorage
  const [chats, setChats] = useState<{
    id: string;
    name: string;
    updated: number;
    messages: ChatMessage[];
  }[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  // Historique A-11 (backend)
  const [a11History, setA11History] = useState<A11HistoryItem[]>([]);
  const [a11ConvId, setA11ConvId] = useState<string | null>(null);
  const [a11ConvMsgs, setA11ConvMsgs] = useState<A11HistoryMessage[]>([]);
  const [conversationActivity, setConversationActivity] = useState<A11ConversationActivityEntry[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [conversationResources, setConversationResources] = useState<A11ConversationResource[]>([]);
  const [loadingResources, setLoadingResources] = useState(false);
  const [resourceError, setResourceError] = useState("");
  const [uploadFeedback, setUploadFeedback] = useState("");
  const [createArtifactOpen, setCreateArtifactOpen] = useState(false);
  const [creatingArtifact, setCreatingArtifact] = useState(false);
  const [creatingMessageArtifactRequest, setCreatingMessageArtifactRequest] = useState<{
    id: string;
    mode: "save" | "mail" | "download";
  } | null>(null);
  const [createArtifactError, setCreateArtifactError] = useState("");
  const [downloadingResourceId, setDownloadingResourceId] = useState<number | null>(null);
  const [emailingResourceId, setEmailingResourceId] = useState<number | null>(null);
  const [emailDialogResource, setEmailDialogResource] = useState<A11ConversationResource | null>(null);
  const [emailDialogError, setEmailDialogError] = useState("");
  const [renameDialog, setRenameDialog] = useState<{ id: string; currentName: string } | null>(null);
  const [deleteDialogChatId, setDeleteDialogChatId] = useState<string | null>(null);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'admin'>('chat');
  const [purgingMemory, setPurgingMemory] = useState(false);
  const [purgeFeedback, setPurgeFeedback] = useState<string>("");
  const [memoryPurgeDryRun, setMemoryPurgeDryRun] = useState(true);
  const [purgeHistory, setPurgeHistory] = useState<PurgeHistoryEntry[]>([]);

  // load chats from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("a11:chats");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          // sanitize chats and messages to conform to expected types
          const sanitizeRole = (r: any) => (r === 'user' || r === 'assistant' || r === 'system') ? r as Role : 'assistant' as Role;
          const normalizeSystemContent = (content: string) => {
            const value = String(content || '');
            if (
              value.includes('utilise les capacités locales') ||
              value.includes('assistant local NOSSEN')
            ) {
              return DEFAULT_SYSTEM_NINDO;
            }
            return value;
          };
          const sanitized = parsed.map((c: any) => ({
            id: String(c.id || `chat-${Date.now()}`),
            name: String(c.name || 'Conversation'),
            updated: Number(c.updated) || Date.now(),
            messages: Array.isArray(c.messages) ? c.messages.map((m: any) => {
              const role = sanitizeRole(m.role);
              const rawContent = String(m.content || '');
              return {
                id: String(m.id || (`m-${Date.now()}`)),
                role,
                content: role === 'system' ? normalizeSystemContent(rawContent) : rawContent
              };
            }) : [{ id: `sys-${Date.now()}`, role: 'system' as Role, content: DEFAULT_SYSTEM_NINDO }]
          }));
          setChats(sanitized);
          setSelectedChatId(sanitized[0].id);
          setMessages(sanitized[0].messages || [{ id: `sys-${Date.now()}`, role: 'system' as Role, content: DEFAULT_SYSTEM_NINDO }]);
          return;
        }
      }
    } catch (e) {
      console.warn("[A11] failed to load chats", e);
    }
    // default chat
    const initial = [
      {
        id: "chat-1",
        name: "Session actuelle",
        updated: Date.now(),
        messages: [
          { id: `sys-${Date.now()}`, role: 'system' as Role, content: DEFAULT_SYSTEM_NINDO },
        ],
      },
    ];
    setChats(initial);
    setSelectedChatId(initial[0].id);
    setMessages(initial[0].messages);
  }, []);

  useEffect(() => {
    try {
      if (localStorage.getItem('a11:tts-only') === '1') {
        setTtsFallback(true);
      }
    } catch {
      // ignore storage access errors
    }
  }, []);

  useEffect(() => {
    setTtsQueueEnabled(ttsFallback || voiceListening);
  }, [ttsFallback, voiceListening]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('a11:memory-purge-history');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setPurgeHistory(
          parsed
            .filter((item: any) => item && typeof item.at === 'string')
            .slice(0, 10)
        );
      }
    } catch {
      // ignore corrupted local history
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('a11:memory-purge-history', JSON.stringify(purgeHistory.slice(0, 10)));
    } catch {
      // ignore storage failures
    }
  }, [purgeHistory]);

  // persist chats whenever changed
  useEffect(() => {
    try {
      localStorage.setItem("a11:chats", JSON.stringify(chats));
    } catch (e) {
      console.warn("[A11] failed to save chats", e);
    }
  }, [chats]);

  // helper to update messages for selected chat
  function updateChatMessages(chatId: string | null, newMessages: ChatMessage[]) {
    if (!chatId) return;
    setChats((prev) =>
      prev.map((c) =>
        c.id === chatId ? { ...c, messages: newMessages, updated: Date.now() } : c
      )
    );
  }

  function mapBackendConversationMessages(rawMessages: any[]): ChatMessage[] {
    return (Array.isArray(rawMessages) ? rawMessages : []).map((message: any, index: number) => ({
      id: String(message?.id || `backend-msg-${Date.now()}-${index}`),
      role: message?.role === "user" || message?.role === "assistant" || message?.role === "system"
        ? message.role
        : "assistant",
      content: String(message?.content || ""),
      imageUrl: typeof message?.imageUrl === "string" ? message.imageUrl : null,
    }));
  }

  const currentConversationId = a11ConvId || selectedChatId;

  async function refreshConversationActivity(conversationId?: string | null) {
    const targetConversationId = String(conversationId || "").trim();
    if (!targetConversationId) {
      setConversationActivity([]);
      setActivityError("");
      return;
    }

    setLoadingActivity(true);
    setActivityError("");
    try {
      const payload = await fetchA11ConversationActivity(targetConversationId, { limit: 12 });
      setConversationActivity(Array.isArray(payload?.entries) ? payload.entries : []);
    } catch (error_) {
      console.warn("[A11] failed to load conversation activity", error_);
      setConversationActivity([]);
      setActivityError((error_ as Error).message || "Chargement de l'activite impossible");
    } finally {
      setLoadingActivity(false);
    }
  }

  async function refreshConversationResources(conversationId?: string | null) {
    const targetConversationId = String(conversationId || "").trim();
    if (!targetConversationId) {
      setConversationResources([]);
      setResourceError("");
      return;
    }

    setLoadingResources(true);
    setResourceError("");
    try {
      const payload = await fetchA11ConversationResources(targetConversationId, { limit: 24 });
      setConversationResources(Array.isArray(payload?.resources) ? payload.resources : []);
    } catch (error_) {
      console.warn("[A11] failed to load conversation resources", error_);
      setConversationResources([]);
      setResourceError((error_ as Error).message || "Chargement des ressources impossible");
    } finally {
      setLoadingResources(false);
    }
  }

  async function handleEmailResource(resource: A11ConversationResource) {
    if (typeof resource.id !== "number") return;
    setEmailDialogError("");
    setEmailDialogResource(resource);
  }

  async function handleDownloadResource(resource: A11ConversationResource) {
    if (typeof resource.id !== "number") return;
    setDownloadingResourceId(resource.id);
    setUploadFeedback("Preparation du telechargement...");
    try {
      const result = await downloadConversationResource(resource);
      setUploadFeedback(`Telechargement lance: ${result.filename}`);
      await refreshConversationActivity(resource.conversationId || currentConversationId);
    } catch (error_) {
      console.warn("[A11] failed to download resource", error_);
      const errorMessage = (error_ as Error).message || String(error_);
      setUploadFeedback(`Echec telechargement: ${errorMessage}`);
    } finally {
      setDownloadingResourceId(null);
    }
  }

  function closeEmailDialog() {
    if (emailingResourceId) return;
    setEmailDialogError("");
    setEmailDialogResource(null);
  }

  function openCreateArtifactDialog() {
    setCreateArtifactError("");
    setCreateArtifactOpen(true);
  }

  function closeCreateArtifactDialog() {
    if (creatingArtifact) return;
    setCreateArtifactError("");
    setCreateArtifactOpen(false);
  }

  async function submitCreateArtifact(payload: {
    format: ArtifactFormat;
    filename: string;
    description?: string;
    openEmailAfterCreate: boolean;
    downloadAfterCreate: boolean;
  }) {
    const conversationId = currentConversationId || selectedChatId || undefined;
    if (!conversationId) return;

    const exportPayload = buildConversationArtifactContent(messages, {
      conversationId,
      format: payload.format,
    });

    setCreatingArtifact(true);
    setCreateArtifactError("");
    setUploadFeedback("Creation de l'artefact en cours...");
    try {
      const result = await createTextArtifact({
        filename: payload.filename,
        text: exportPayload.text,
        contentType: exportPayload.contentType,
        kind: exportPayload.kind,
        conversationId,
        description: payload.description,
      });
      setCreateArtifactOpen(false);
      await refreshConversationResources(conversationId);
      await refreshConversationActivity(conversationId);
      if (payload.downloadAfterCreate && result.conversationResource?.id) {
        await downloadConversationResource(result.conversationResource);
      }
      if (payload.openEmailAfterCreate && result.conversationResource?.id) {
        setEmailDialogError("");
        setEmailDialogResource(result.conversationResource);
      }
      if (payload.openEmailAfterCreate && payload.downloadAfterCreate) {
        setUploadFeedback(`Artefact ${result.artifact?.filename || payload.filename} cree, telecharge et pret a etre envoye.`);
      } else if (payload.openEmailAfterCreate) {
        setUploadFeedback(`Artefact ${result.artifact?.filename || payload.filename} cree et pret pour l'envoi mail.`);
      } else if (payload.downloadAfterCreate) {
        setUploadFeedback(`Artefact ${result.artifact?.filename || payload.filename} cree et telecharge.`);
      } else {
        setUploadFeedback(`Artefact ${result.artifact?.filename || payload.filename} cree et stocke.`);
      }
    } catch (error_) {
      console.warn("[A11] artifact creation failed", error_);
      const errorMessage = (error_ as Error).message || String(error_);
      setCreateArtifactError(errorMessage);
      setUploadFeedback(`Echec creation artefact: ${errorMessage}`);
    } finally {
      setCreatingArtifact(false);
    }
  }

  async function saveAssistantMessageArtifact(
    message: ChatMessage,
    messageIndex: number,
    options?: { openEmailAfterCreate?: boolean; downloadAfterCreate?: boolean }
  ) {
    const conversationId = currentConversationId || selectedChatId || undefined;
    if (!conversationId || message.role !== "assistant" || !String(message.content || "").trim()) return;

    const artifactPayload = buildAssistantMessageArtifact(message, {
      conversationId,
      index: messageIndex,
    });

    const openEmailAfterCreate = !!options?.openEmailAfterCreate;
    const downloadAfterCreate = !!options?.downloadAfterCreate;
    setCreatingMessageArtifactRequest({
      id: message.id,
      mode: openEmailAfterCreate ? "mail" : (downloadAfterCreate ? "download" : "save"),
    });
    setUploadFeedback(
      openEmailAfterCreate
        ? "Sauvegarde de la reponse puis ouverture du mail..."
        : (downloadAfterCreate
          ? "Sauvegarde de la reponse puis telechargement..."
          : "Sauvegarde de la reponse en artefact...")
    );
    try {
      const result = await createTextArtifact({
        filename: artifactPayload.filename,
        text: artifactPayload.text,
        contentType: artifactPayload.contentType,
        kind: artifactPayload.kind,
        conversationId,
        description: artifactPayload.description,
      });
      await refreshConversationResources(conversationId);
      await refreshConversationActivity(conversationId);
      if (downloadAfterCreate && result.conversationResource?.id) {
        await downloadConversationResource(result.conversationResource);
      }
      if (openEmailAfterCreate && result.conversationResource?.id) {
        setEmailDialogError("");
        setEmailDialogResource(result.conversationResource);
        setUploadFeedback(`Reponse sauvegardee: ${result.artifact?.filename || artifactPayload.filename}. Envoi mail pret.`);
      } else if (downloadAfterCreate) {
        setUploadFeedback(`Reponse sauvegardee: ${result.artifact?.filename || artifactPayload.filename}. Telechargement lance.`);
      } else {
        setUploadFeedback(`Reponse sauvegardee: ${result.artifact?.filename || artifactPayload.filename}`);
      }
    } catch (error_) {
      console.warn("[A11] assistant message artifact failed", error_);
      const errorMessage = (error_ as Error).message || String(error_);
      setUploadFeedback(`Echec sauvegarde reponse: ${errorMessage}`);
    } finally {
      setCreatingMessageArtifactRequest(null);
    }
  }

  async function submitEmailResource(payload: { to: string; subject?: string; message?: string; attachToEmail: boolean }) {
    const resource = emailDialogResource;
    if (!resource || typeof resource.id !== "number") return;

    setEmailingResourceId(resource.id);
    setEmailDialogError("");
    setUploadFeedback("Envoi mail en cours...");
    try {
      const result = await emailConversationResource(resource.id, {
        to: payload.to.trim(),
        subject: payload.subject,
        message: payload.message,
        attachToEmail: payload.attachToEmail,
      });
      const attachmentLabel = result.mail?.attachmentIncluded ? "avec piece jointe" : "avec lien";
      setUploadFeedback(`Mail envoye vers ${payload.to.trim()} ${attachmentLabel}.`);
      setEmailDialogResource(null);
      await refreshConversationResources(resource.conversationId || currentConversationId);
      await refreshConversationActivity(resource.conversationId || currentConversationId);
    } catch (error_) {
      console.warn("[A11] failed to email resource", error_);
      const errorMessage = (error_ as Error).message || String(error_);
      setEmailDialogError(errorMessage);
      setUploadFeedback(`Echec envoi mail: ${errorMessage}`);
    } finally {
      setEmailingResourceId(null);
    }
  }

  function onImportClick() {
    fileInputRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    handleImportFiles(files, (txt: string) => {
      setInput((prev) => (prev ? prev + "\n" + txt : txt));
    }).catch(console.error);

    if (!files || files.length === 0) return;

    const conversationId = a11ConvId || selectedChatId || undefined;
    const uploaded: string[] = [];
    const failed: string[] = [];
    setUploadFeedback(`Import de ${files.length} fichier(s) en cours...`);
    for (const file of Array.from(files)) {
      try {
        await uploadConversationFile(file, { conversationId });
        uploaded.push(file.name);
      } catch (error_) {
        console.warn("[A11] file upload failed", file.name, error_);
        failed.push(file.name);
      }
    }

    if (conversationId) {
      await refreshConversationActivity(conversationId);
      await refreshConversationResources(conversationId);
    }

    if (uploaded.length && failed.length) {
      setUploadFeedback(`Import partiel: ${uploaded.length} ok, ${failed.length} en echec.`);
    } else if (uploaded.length) {
      setUploadFeedback(`${uploaded.length} fichier(s) rattache(s) a la conversation.`);
    } else if (failed.length) {
      setUploadFeedback(`Echec import: ${failed.join(", ")}`);
    }

    e.target.value = "";
  }

  // New conversation handler
  function newConversation() {
    // create new chat entry and select it
    const id = `chat-${Date.now()}`;
    const newChat = {
      id,
      name: `Conversation ${chats.length + 1}`,
      updated: Date.now(),
      messages: [{ id: `sys-${Date.now()}`, role: 'system' as Role, content: DEFAULT_SYSTEM_NINDO }],
    };
    setChats((prev) => [newChat, ...prev]);
    setSelectedChatId(id);
    setA11ConvId(null);
    setA11ConvMsgs([]);
    setMessages(newChat.messages);
    setInput("");
    setConversationActivity([]);
    setConversationResources([]);
    setActivityError("");
    setUploadFeedback("");
  }

  // Speech recognition callback
  useEffect(() => {
    initSpeech((txt: string, isFinal?: boolean) => {
      if (isFinal) {
        setInput(""); // vide l'input
        sendMessage(txt); // envoie direct le texte reconnu
      } else {
        setInput(() => txt);
      }
    });
  }, []);

  // Modifie la fonction sendMessage pour accepter un texte forcé
  async function sendMessage(forcedText?: string) {
    const text = (forcedText ?? input).trim();
    if (!text || sending) return;

    // Ajout du préfixe DEV_ENGINE si mode dev
    const prefix = devMode ? "[DEV_ENGINE] " : "";
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}}`,
      role: "user",
      content: prefix + text,
    };
    setMessages((prev) => {
      const nm = [...prev, userMsg];
      updateChatMessages(selectedChatId, nm);
      return nm;
    });
    setInput("");
    setSending(true);

    try {
      // Utilisation de chatCompletion pour transmettre le prompt et le flag dev
      // On reconstruit l'historique sans les messages système (le prompt système est passé séparément)
      const history = messages.filter(m => m.role !== 'system').concat(userMsg);
      const provider: Provider = model.startsWith('gpt') ? 'openai' : 'local';
      const assistantText = await chatCompletion(
        history,
        provider,
        {
          model,
          systemPrompt: systemPrompt,
          a11Dev: devMode,
          conversationId: selectedChatId || undefined,
        }
      );

      const aiMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: String(assistantText),
      };
      setMessages((prev) => {
        const nm = [...prev, aiMsg];
        updateChatMessages(selectedChatId, nm);
        return nm;
      });
      await refreshConversationActivity(selectedChatId || a11ConvId);

      if (ttsFallback || voiceListening) {
        speak(String(assistantText), { lang: "fr-FR" });
      }
    } catch (err: any) {
      const errMsg: ChatMessage = {
        id: `e-${Date.now()}`,
        role: "assistant",
        content:
          "Erreur lors de l’appel à /api/llm/chat : " + (err?.message || err),
      };
      setMessages((prev) => {
        const nm = [...prev, errMsg];
        updateChatMessages(selectedChatId, nm);
        return nm;
      });
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  async function toggleMic() {
    console.log("[A11] toggleMic clicked, current voiceListening=", voiceListening);
    // If audio is playing, stop it immediately and do not toggle modes
    if (audioPlaying) {
      console.log("[A11] canceling audio playback via toggle");
      cancelSpeech();
      return;
    }
    const SpeechRecognition =
      (globalThis as any).SpeechRecognition ||
      (globalThis as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      if (toggleLockRef.current) {
        console.log("[A11] toggle ignored due to lock");
        return;
      }
      toggleLockRef.current = true;
      setTimeout(() => { toggleLockRef.current = false; }, 600);
      // fallback: toggle TTS-only mode
      setTtsFallback((v) => {
        const next = !v;
        // keep voiceListening false when using fallback
        if (next) {
          // enable TTS playback
          console.log("[A11] SpeechRecognition not available — enabling TTS-only mode");
        } else {
          console.log("[A11] Disabling TTS-only mode");
        }
        return next;
      });
      return;
    }

    if (voiceListening) {
      try { stopMic(); } catch {};
      setVoiceListening(false);
      cancelSpeech();
    } else {
      try { await startMic(); setVoiceListening(true); } catch (e) { console.warn('startMic failed', e); }
    }
  }

  function toggleTtsOnly() {
    if (toggleLockRef.current) {
      console.log('[A11] toggleTtsOnly ignored due to lock');
      return;
    }
    toggleLockRef.current = true;
    setTimeout(() => { toggleLockRef.current = false; }, 600);
    const next = !ttsFallback;
    setTtsFallback(next);
    console.log('[A11] toggleTtsOnly ->', next);
    if (next) {
      localStorage.setItem('a11:tts-only', '1');
    } else {
      localStorage.removeItem('a11:tts-only');
    }
  }

  // Rename chat
  function renameChat(id: string) {
    const c = chats.find(x => x.id === id);
    if (!c) return;
    setRenameDialog({ id, currentName: c.name });
  }

  // Delete chat
  function deleteChat(id: string) {
    setDeleteDialogChatId(id);
  }

  function confirmDeleteChat() {
    const id = deleteDialogChatId;
    if (!id) return;
    setChats(prev => {
      const next = prev.filter(x => x.id !== id);
      if (next.length === 0) {
        // recreate default
        const initial = { id: 'chat-1', name: 'Session actuelle', updated: Date.now(), messages: [{ id: `sys-${Date.now()}`, role: 'system' as Role, content: DEFAULT_SYSTEM_NINDO }] };
        setSelectedChatId(initial.id);
        setMessages(initial.messages);
        return [initial];
      }
      // select first if deleted was selected
      if (selectedChatId === id) {
        setSelectedChatId(next[0].id);
        setMessages(next[0].messages);
      }
      return next;
    });
    setDeleteDialogChatId(null);
  }

  // NINDO layers (à adapter selon ton code)
  const nindoLayers = {
    core: DEFAULT_SYSTEM_NINDO,
    dev: '',
    project: '',
    session: '',
  };

  // Prompt système pour le mode CHAT normal
  const systemPromptChat = useMemo(() => {
    const parts: string[] = [];
    parts.push(`# NINDO CORE\n${nindoLayers.core}`);
    if (nindoLayers.project.trim()) {
      parts.push(`# NINDO PROJET\n${nindoLayers.project}`);
    }
    if (nindoLayers.session.trim()) {
      parts.push(`# NINDO SESSION\n${nindoLayers.session}`);
    }
    // Règle anti-blabla
    parts.push(
      `# RÈGLES\n- Réponds uniquement à la demande de l'utilisateur.\n- N'invente jamais de contexte ou de scénario.\n- Ne propose aucune action non demandée explicitement.\n- Ne réponds jamais par un JSON d'action, une enveloppe d'outil ou une pseudo commande.\n- Si la demande n'est pas claire, pose une seule question de clarification.\n- Si la question est triviale, réponds en une phrase maximum.`
    );
    return parts.join("\n\n---\n\n");
  }, [nindoLayers]);

  // Prompt système pour le mode DEV (ingé / fichiers)
  const systemPromptDev = useMemo(() => {
    const parts: string[] = [];
    parts.push(`# NINDO CORE\n${nindoLayers.core}`);
    if (nindoLayers.dev.trim()) {
      parts.push(`# NINDO DEV\n${nindoLayers.dev}`);
    }
    if (nindoLayers.project.trim()) {
      parts.push(`# NINDO PROJET\n${nindoLayers.project}`);
    }
    if (nindoLayers.session.trim()) {
      parts.push(`# NINDO SESSION\n${nindoLayers.session}`);
    }
    parts.push(
      `# MODE DEV (A-11 DEVELOPER ENGINE)
- Tu te comportes comme un ingénieur logiciel dans un vrai workspace local.
- Tu peux proposer des actions JSON (mode "actions") pour Cerbère (write_file, generate_pdf, etc.).
- Actions supportees: write_file, download_file, generate_pdf, generate_png.
- N'invente jamais une action non supportee. Par exemple, n'utilise pas "generate_image": utilise "generate_png".
- Tu évites les actions destructrices.
- Tu ne t'inventes pas de problème : si tu n'as pas assez de contexte, tu demandes des fichiers / erreurs.

- Quand l'utilisateur demande un PDF explicatif (cours, fiche, dossier, etc.),
  tu dois créer AU MOINS 4 sections détaillées, avec plusieurs paragraphes.
- Utilise de préférence la structure :
  sections = [
    { "heading": "Introduction", "text": "...", "images": [...] },
    { "heading": "Partie 1 : ...", "text": "...", "images": [...] },
    { "heading": "Partie 2 : ...", "text": "...", "images": [...] },
    { "heading": "Conclusion", "text": "..." }
  ]
- Pour inclure une image dans le PDF, elle doit déjà être présente sur le disque.
  D'abord tu utilises l'action "download_file" pour télécharger l'image dans "docs/...",
  ensuite tu passes ce chemin dans "sections[].images".

EN MODE DEV (fichiers / workspace) :
- Si l'utilisateur demande de CRÉER, LIRE, MODIFIER un fichier, un PDF, une image, etc.,
  TU NE RÉPONDS PAS en texte.
- Tu renvoies UNIQUEMENT un JSON valide de la forme :

{ "mode": "actions", "actions": [ { "action": "write_file", "path": "docs/test.txt", "content": "Contenu du fichier..." } ] }

- Pour CRÉER / MODIFIER un fichier texte : utilise "write_file" (champ "content" en texte).
- Pour TÉLÉCHARGER une image ou un fichier depuis une URL : utilise "download_file" avec
  { "action": "download_file", "url": "https://...", "path": "docs/mon_image.png" }.
- Pour CRÉER un PDF structuré : utilise "generate_pdf" avec "title" et "sections"
  (chaque section a "heading", "text" et éventuellement "images" = liste de chemins locaux).

RÈGLES STRICTES :
- Pas de triple backticks autour.
- Pas de mot "json" avant.
- Le PREMIER caractère de ta réponse doit être {.
- Le DERNIER caractère de ta réponse doit être }.
- Aucune explication avant ou après le JSON.`
    );
    return parts.join("\n\n---\n\n");
  }, [nindoLayers]);

  // Prompt effectivement utilisé selon le mode
  const systemPrompt = devMode ? systemPromptDev : systemPromptChat;

  // Initialisation globale de window.speak au montage pour garantir le son
  useEffect(() => {
    (globalThis as any).speak = speak;
  }, [devMode, stats]);

  // Chargement de l'historique backend au montage
  useEffect(() => {
    refreshA11History();
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (activeView !== 'chat') return;
    refreshConversationActivity(currentConversationId);
    refreshConversationResources(currentConversationId);
  }, [isAuthenticated, activeView, currentConversationId]);

  useEffect(() => {
    if (!uploadFeedback) return;
    const timeout = globalThis.setTimeout(() => setUploadFeedback(""), 5000);
    return () => globalThis.clearTimeout(timeout);
  }, [uploadFeedback]);

  // Handler pour rafraîchir la liste de l'historique
  async function refreshA11History() {
    setLoadingHistory(true);
    try {
      const list = await fetchA11HistoryList();
      setA11History(list);
    } catch (error_) {
      console.warn('[A11] failed to refresh history', error_);
      setA11History([]);
    } finally {
      setLoadingHistory(false);
    }
  }

  // Handler pour ouvrir/restaurer une conversation backend
  async function handleOpenA11Conversation(convId: string) {
    setA11ConvId(convId);
    setA11ConvMsgs([]);
    setUploadFeedback("");
    setLoadingHistory(true);
    try {
      const conv = await fetchA11Conversation(convId);
      const normalizedMessages = mapBackendConversationMessages(conv.messages || []);
      setA11ConvMsgs(normalizedMessages);
      setActiveView('chat');
      setSelectedChatId(convId);
      setMessages(normalizedMessages);
      setChats((prev) => {
        const existing = prev.find((chat) => chat.id === convId);
        if (existing) {
          return prev.map((chat) =>
            chat.id === convId
              ? { ...chat, name: existing.name || convId, messages: normalizedMessages, updated: Date.now() }
              : chat
          );
        }
        return [
          {
            id: convId,
            name: convId === 'default' ? 'Session par defaut' : convId,
            updated: Date.now(),
            messages: normalizedMessages,
          },
          ...prev,
        ];
      });
    } catch (error_) {
      console.warn('[A11] failed to open conversation', error_);
      setA11ConvMsgs([]);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handlePurgeMemoryNow() {
    if (purgingMemory) return;
    setPurgingMemory(true);
    setPurgeConfirmOpen(false);
    setPurgeFeedback('Purge en cours...');
    try {
      const result = await purgeMemoryNow({ dryRun: memoryPurgeDryRun });
      const effectiveRemoved = result.dryRun ? (result.wouldRemove || { facts: 0, tasks: 0, files: 0 }) : result.removed;
      const removedTotal = effectiveRemoved.facts + effectiveRemoved.tasks + effectiveRemoved.files;
      setPurgeFeedback(
        result.dryRun
          ? `Dry run OK (${removedTotal} candidats) • facts ${effectiveRemoved.facts}, tasks ${effectiveRemoved.tasks}, files ${effectiveRemoved.files}`
          : `Purge OK (${removedTotal} supprimés) • facts ${result.before.facts}->${result.after.facts}, tasks ${result.before.tasks}->${result.after.tasks}, files ${result.before.files}->${result.after.files}`
      );
      setPurgeHistory((prev) => [
        {
          at: result.purgeTriggeredAt,
          dryRun: !!result.dryRun,
          removed: {
            facts: effectiveRemoved.facts,
            tasks: effectiveRemoved.tasks,
            files: effectiveRemoved.files,
          },
        },
        ...prev,
      ].slice(0, 10));
    } catch (err) {
      setPurgeFeedback(`Echec purge: ${(err as Error).message || String(err)}`);
    } finally {
      setPurgingMemory(false);
    }
  }

  // HEADER avec bouton Mode DEV centré, select modèle à droite, mute à l'extrême droite
  
  // ✅ Check authentication
  if (isResetRoute) {
    return <ResetPasswordPanel />;
  }

  if (!isAuthenticated) {
    return <LoginPanel onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="app-container" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        className="header"
        style={{
          width: "100%",
          minHeight: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 24px",
          borderBottom: "1px solid #111827",
          background: "#0a101a",
          zIndex: 10,
        }}
      >
        {/* Avatar + nom à gauche */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 999,
              overflow: "hidden",
              boxShadow: "0 0 12px #22d3ee99",
              flexShrink: 0,
            }}
          >
            <img
              id="a11-avatar"
              src={speaking ? "/assets/A11_talking_smooth_8s.gif" : "/assets/a11_static.png"}
              alt="A-11"
              onError={(e) => {
                e.currentTarget.src = "/assets/a11_static.png";
              }}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          </div>
          <div>
            <div style={{ fontWeight: 700, color: "#e5e7eb" }}>AlphaOnze (A-11)</div>
            <div style={{ fontSize: 12, color: "#9ca3af" }}>Assistant local NOSSEN</div>
          </div>
        </div>
        {/* Mode DEV centré + badge backend */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={() => setDevMode((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 14px",
              borderRadius: 999,
              border: "1px solid " + (devMode ? "#f97316" : "#1f2937"),
              background: devMode ? "#7c2d12" : "#020617",
              color: devMode ? "#fed7aa" : "#e5e7eb",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: devMode ? "0 0 8px #f9731633" : undefined,
              letterSpacing: 1,
            }}
            title={
              devMode
                ? "Mode DEV activé : A-11 peut modifier des fichiers (via Cerbère)"
                : "Mode DEV désactivé : A-11 reste en mode chat normal"
            }
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: devMode ? "#fb923c" : "#6b7280",
                marginRight: 6,
              }}
            />
            <span>Mode DEV</span>
          </button>
        </div>
        {/* Select modèle + MuteButton + badge backend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <select
            value={model}
            onChange={e => setModel(e.target.value)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              background: "#181f2a",
              color: "#e5e7eb",
              border: "1px solid #22293a",
              fontSize: 13,
              marginRight: 2
            }}
          >
            <option value="gpt-4o-mini">gpt-4o-mini</option>
            <option value="gpt-4.1-mini">gpt-4.1-mini</option>
          </select>
          <MuteButton />
          {stats && (
            <div
              style={{
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 999,
                background: "#0f172a",
                color: "#9ca3af",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: stats.gpu ? "#22c55e" : "#eab308",
                }}
              />
              <span>{stats.backend}</span>
              <span style={{ opacity: 0.7 }}>· {stats.model}</span>
            </div>
          )}
        </div>
        <MuteButton />
        {/* ✅ LOGOUT BUTTON */}
        <button
          onClick={() => {
            logout();
            setIsAuthenticated(false);
          }}
          style={{
            padding: "8px 16px",
            borderRadius: "4px",
            border: "1px solid #dc2626",
            background: "transparent",
            color: "#fca5a5",
            cursor: "pointer",
            fontWeight: "bold",
            fontSize: "13px"
          }}
          title="Logout"
        >
          🚪 Logout
        </button>
      </header>
      {/* Grille principale : sidebar + main */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Sidebar : conversations locales + historique backend */}
        <aside className="sidebar" style={{ width: 320, borderRight: "1px solid #22293a", background: "#0a101a", display: 'flex', flexDirection: 'column' }}>
          {/* Bloc conversations locales */}
          <div style={{ borderBottom: '1px solid #22293a', padding: '8px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px 4px 16px' }}>
              <span className="text-xs uppercase tracking-wide text-slate-400">Conversations locales</span>
              <button onClick={newConversation} className="btn ghost" style={{ fontSize: 13, padding: '2px 10px' }}>+ Nouvelle</button>
            </div>
            <div>
              {chats.map(chat => (
                <div
                  key={chat.id}
                  style={{
                    fontWeight: chat.id === selectedChatId ? "bold" : "normal",
                    background: chat.id === selectedChatId ? "#22293a" : "transparent",
                    padding: '6px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderRadius: 6,
                    margin: '2px 8px',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveView('chat');
                      setSelectedChatId(chat.id);
                      setMessages(chat.messages);
                      setA11ConvId(null);
                      setA11ConvMsgs([]);
                    }}
                    className="btn ghost"
                    style={{ flex: 1, padding: 0, border: 'none', background: 'transparent', textAlign: 'left', justifyContent: 'flex-start' }}
                  >
                    {chat.name}
                  </button>
                  <span style={{ display: 'flex', gap: 4 }}>
                    <button onClick={e => { e.stopPropagation(); renameChat(chat.id); }} title="Renommer" className="btn ghost" style={{ fontSize: 13 }}>✏️</button>
                    <button onClick={e => { e.stopPropagation(); deleteChat(chat.id); }} title="Supprimer" className="btn ghost" style={{ fontSize: 13 }}>🗑️</button>
                  </span>
                </div>
              ))}
            </div>
          </div>
          {/* Historique backend */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Historique A-11
              </span>
              <button onClick={refreshA11History} className="text-[11px] text-slate-400 hover:text-slate-200">
                ↻
              </button>
            </div>
            {loadingHistory ? (
              <div className="p-3 text-xs text-slate-400">Chargement…</div>
            ) : (
              <A11HistoryPanel
                items={a11History}
                activeId={a11ConvId}
                onSelect={handleOpenA11Conversation}
              />
            )}
          </div>
          <div style={{ borderTop: '1px solid #22293a', padding: '8px 12px' }}>
            <div className="text-xs uppercase tracking-wide text-slate-400" style={{ marginBottom: 8 }}>
              Administration
            </div>
            <button
              type="button"
              onClick={() => setActiveView('admin')}
              className="btn ghost"
              style={{ width: '100%', justifyContent: 'flex-start', border: activeView === 'admin' ? '1px solid #334155' : undefined }}
            >
              Memory Controls
            </button>
          </div>
        </aside>
        {/* ...main... */}
        <main className="main" style={{ flex: 1, minWidth: 0 }}>
          {activeView === 'admin' ? (
            <div style={{ padding: 20, maxWidth: 760 }}>
              <h2 style={{ marginTop: 0, color: '#e2e8f0' }}>Administration mémoire</h2>
              <p style={{ color: '#94a3b8', marginTop: 4 }}>
                Contrôle dédié pour lancer la purge de la mémoire structurée.
              </p>

              <div style={{
                marginTop: 16,
                padding: 14,
                border: '1px solid #1f2937',
                borderRadius: 10,
                background: '#0b1220',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#cbd5e1', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={memoryPurgeDryRun}
                    onChange={(e) => setMemoryPurgeDryRun(e.target.checked)}
                    disabled={purgingMemory}
                  />
                  Dry run (simulation sans suppression)
                </label>
                <button
                  type="button"
                  onClick={() => setPurgeConfirmOpen(true)}
                  disabled={purgingMemory}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid #f59e0b',
                    background: purgingMemory ? '#3f2a08' : 'transparent',
                    color: '#fcd34d',
                    cursor: purgingMemory ? 'not-allowed' : 'pointer',
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  {purgingMemory ? 'Execution...' : 'Lancer purge maintenant'}
                </button>
              </div>

              {purgeFeedback && (
                <div style={{
                  marginTop: 14,
                  padding: 10,
                  borderRadius: 8,
                  border: `1px solid ${purgeFeedback.startsWith('Echec') ? '#7f1d1d' : '#1e3a8a'}`,
                  background: purgeFeedback.startsWith('Echec') ? '#2a0f0f' : '#0f172a',
                  color: purgeFeedback.startsWith('Echec') ? '#fecaca' : '#bfdbfe',
                  fontSize: 12,
                }}>
                  {purgeFeedback}
                </div>
              )}

              <div style={{ marginTop: 18 }}>
                <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: 16 }}>Historique local</h3>
                {purgeHistory.length === 0 ? (
                  <div style={{ marginTop: 8, color: '#94a3b8', fontSize: 13 }}>Aucune purge locale pour le moment.</div>
                ) : (
                  <div style={{ marginTop: 8, border: '1px solid #1f2937', borderRadius: 8, overflow: 'hidden' }}>
                    {purgeHistory.map((entry, index) => (
                      <div
                        key={`${entry.at}-${index}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 10,
                          padding: '10px 12px',
                          borderTop: index === 0 ? 'none' : '1px solid #1f2937',
                          background: index % 2 === 0 ? '#0b1220' : '#0a101a',
                          color: '#cbd5e1',
                          fontSize: 12,
                        }}
                      >
                        <span>{new Date(entry.at).toLocaleString()}</span>
                        <span>{entry.dryRun ? 'dryRun' : 'purge'}</span>
                        <span>facts {entry.removed.facts} | tasks {entry.removed.tasks} | files {entry.removed.files}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <A11OpsStatusPanel />
              <A11VsixDebugPanel />
            </div>
          ) : (
          <>
          <ConversationActivityPanel
            conversationId={currentConversationId}
            entries={conversationActivity}
            loading={loadingActivity}
            error={activityError || null}
            onRefresh={() => refreshConversationActivity(currentConversationId)}
          />
          <ConversationResourcesPanel
            conversationId={currentConversationId}
            resources={conversationResources}
            loading={loadingResources}
            creatingArtifact={creatingArtifact}
            error={resourceError || null}
            uploadFeedback={uploadFeedback || null}
            onCreateArtifact={openCreateArtifactDialog}
            onRefresh={() => refreshConversationResources(currentConversationId)}
            onDownloadResource={handleDownloadResource}
            downloadingResourceId={downloadingResourceId}
            onEmailResource={handleEmailResource}
            emailingResourceId={emailingResourceId}
          />
          <div className="scroll-frame">
            <div className="log">
              {messages.map((m, idx) => {
                const isSavingMessageArtifact = creatingMessageArtifactRequest?.id === m.id;
                const isSavingMessageArtifactAndMail = isSavingMessageArtifact && creatingMessageArtifactRequest?.mode === "mail";
                const isSavingMessageArtifactAndDownload = isSavingMessageArtifact && creatingMessageArtifactRequest?.mode === "download";
                const exportSuggestion = m.role === "assistant" ? detectAssistantExportSuggestion(m.content) : null;
                let messageClassName = "message ";
                let roleLabel = "Système / Nindo";
                if (m.role === "user") {
                  messageClassName = "message user";
                  roleLabel = "Toi";
                } else if (m.role === "assistant") {
                  messageClassName = "message assistant";
                  roleLabel = "A-11";
                }
                const contentNode = m.role === "assistant"
                  ? <ReactMarkdown>{m.content}</ReactMarkdown>
                  : <div>{m.content}</div>;

                return (
                  <div
                    key={m.id || idx}
                    className={messageClassName}
                  >
                    <div className="role">{roleLabel}</div>
                    {contentNode}
                    {m.imageUrl && (
                      <div className="msg-image">
                        <img
                          src={m.imageUrl}
                          alt="Résultat A-11"
                          style={{ maxWidth: "320px", borderRadius: 12 }}
                        />
                      </div>
                    )}
                    {exportSuggestion ? (
                      <div
                        style={{
                          marginTop: 10,
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: `1px solid ${exportSuggestion.accent}`,
                          background: "#0b1220",
                          color: "#e2e8f0",
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 700, color: exportSuggestion.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Pret a exporter · {exportSuggestion.label}
                        </div>
                        <div style={{ fontSize: 12, color: "#cbd5e1", marginTop: 4 }}>
                          {exportSuggestion.hint}
                        </div>
                      </div>
                    ) : null}
                    {m.role === "assistant" && String(m.content || "").trim() ? (
                      <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => saveAssistantMessageArtifact(m, idx, { downloadAfterCreate: true })}
                          disabled={isSavingMessageArtifact || creatingArtifact}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          {isSavingMessageArtifactAndDownload ? "Telechargement..." : "Sauver + Telecharger"}
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => saveAssistantMessageArtifact(m, idx, { openEmailAfterCreate: true })}
                          disabled={isSavingMessageArtifact || creatingArtifact}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          {isSavingMessageArtifactAndMail ? "Preparation mail..." : "Sauver + Mail"}
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => saveAssistantMessageArtifact(m, idx)}
                          disabled={isSavingMessageArtifact || creatingArtifact}
                          style={{ fontSize: 11, padding: "4px 8px" }}
                        >
                          {isSavingMessageArtifact && !isSavingMessageArtifactAndMail && !isSavingMessageArtifactAndDownload ? "Sauvegarde..." : "Sauver en artefact"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="composer">
            <div className="row">
              <button
                type="button"
                className="btn ghost import-inline"
                onClick={onImportClick}
                title="Importer un fichier texte"
                style={{ marginRight: 8 }}
              >
                Importer
              </button>

              <textarea
                placeholder="Demande quelque chose à A-11…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />

              <button
                type="button"
                className="send-button"
                onClick={() => sendMessage()}
                disabled={sending || !input.trim()}
                title="Entrée pour envoyer, Shift+Entrée pour aller à la ligne"
              >
                {sending ? "…" : "➤"}
              </button>

              <button
                type="button"
                className={`nossen-mic-btn inline ${(voiceListening || ttsFallback || audioPlaying) ? 'listening' : ''}`}
                onClick={toggleMic}
                title="Toggle microphone / TTS"
                style={{ marginLeft: 8 }}
              >
                {(voiceListening || ttsFallback || audioPlaying) ? '🎙️' : '🎤'}
              </button>
            </div>
            <div className="hint">
              Entrée pour envoyer · Shift+Entrée pour aller à la ligne
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
          </>
          )}
        </main>
      </div>
      <footer className="footer">
        A-11 / Qflush UI · Cerbère 4545 · LLaMA local · Funesterie
      </footer>
      {showHistory && <HistoryPanel onClose={() => setShowHistory(false)} />}
      <RenameConversationModal
        open={!!renameDialog}
        currentName={renameDialog?.currentName || ""}
        onClose={() => setRenameDialog(null)}
        onSubmit={(name) => {
          const targetId = renameDialog?.id;
          if (!targetId) return;
          setChats((prev) => prev.map((chat) => chat.id === targetId ? { ...chat, name } : chat));
          setRenameDialog(null);
        }}
      />
      <ConfirmModal
        open={!!deleteDialogChatId}
        title="Supprimer la conversation"
        message="Cette conversation locale sera retirée de la liste actuelle."
        confirmLabel="Supprimer"
        confirmTone="danger"
        onClose={() => setDeleteDialogChatId(null)}
        onConfirm={confirmDeleteChat}
      />
      <ConfirmModal
        open={purgeConfirmOpen}
        title="Confirmer la purge mémoire"
        message={memoryPurgeDryRun
          ? "Lancer une simulation de purge de la mémoire structurée ?"
          : "Déclencher immédiatement la purge réelle de la mémoire structurée ?"}
        confirmLabel={memoryPurgeDryRun ? "Lancer le dry run" : "Lancer la purge"}
        confirmTone={memoryPurgeDryRun ? "primary" : "danger"}
        loading={purgingMemory}
        onClose={() => setPurgeConfirmOpen(false)}
        onConfirm={handlePurgeMemoryNow}
      />
      <EmailResourceModal
        resource={emailDialogResource}
        open={!!emailDialogResource}
        submitting={!!emailDialogResource && emailingResourceId === emailDialogResource.id}
        error={emailDialogError || null}
        onClose={closeEmailDialog}
        onSubmit={submitEmailResource}
      />
      <CreateArtifactModal
        open={createArtifactOpen}
        submitting={creatingArtifact}
        error={createArtifactError || null}
        conversationId={currentConversationId}
        messageCount={messages.filter((message) => message.role !== "system").length}
        onClose={closeCreateArtifactDialog}
        onSubmit={submitCreateArtifact}
      />
      {audioBlockedUrl && (
        <div style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: '#1e293b', border: '1px solid #334155', borderRadius: 12,
          padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 4px 24px rgba(0,0,0,0.6)', zIndex: 9999,
          color: '#e2e8f0', fontSize: 14, whiteSpace: 'nowrap',
        }}>
          <span>🔇 Audio bloqué</span>
          <button
            type="button"
            onClick={() => { retryPlayUrl(audioBlockedUrl); setAudioBlockedUrl(null); }}
            style={{
              background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8,
              padding: '6px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}
          >
            ▶ Jouer
          </button>
          <button
            type="button"
            onClick={() => setAudioBlockedUrl(null)}
            style={{ background: 'none', color: '#94a3b8', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }}
            title="Ignorer"
          >×</button>
        </div>
      )}
    </div>
  );
}

export default App;
