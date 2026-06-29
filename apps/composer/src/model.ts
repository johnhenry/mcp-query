// The model side of Composer. Composer is provider-agnostic: it speaks ONE frontend
// shape (OpenAI Chat Completions) and swaps the *backend* adapter per provider via
// ai.matey. A Bridge(frontend, backend) translates the uniform OpenAI-shaped request
// into whatever the chosen provider expects, then translates the response back.
//
// All provider config (apiKey / baseURL / model) lives in localStorage only — there is
// no server. Browser calls to hosted providers may hit CORS; Ollama-local (proxied via
// Vite's /ollama → :11434) is the zero-config default that works on this box.

import { Bridge } from "ai.matey.core";
import { OpenAIFrontendAdapter } from "ai.matey.frontend";
import {
  OpenAIBackendAdapter,
  AnthropicBackendAdapter,
  OllamaBackendAdapter,
  GroqBackendAdapter,
  GeminiBackendAdapter,
  MistralBackendAdapter,
  OpenRouterBackendAdapter,
} from "ai.matey.backend";
import type { BackendAdapter, BackendAdapterConfig } from "ai.matey.types";

// ── chat message shape (OpenAI-flavoured, what the UI thread holds) ──────────

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// ── provider registry ────────────────────────────────────────────────────────

export type ConfigField = "apiKey" | "baseURL";

export interface ProviderDef {
  id: string;
  label: string;
  /** ai.matey backend adapter class. All backends take a BackendAdapterConfig. */
  BackendAdapter: new (config: BackendAdapterConfig) => BackendAdapter;
  /** Which fields the picker should expose for this provider. */
  configFields: ConfigField[];
  /** Suggested models shown in the picker (the user may type any model id). */
  defaultModels?: string[];
  /** Pre-filled baseURL (Ollama is proxied through Vite at /ollama). */
  defaultBaseURL?: string;
  /** Pre-filled default model. */
  defaultModel?: string;
  /** Hosted providers need a key + likely hit CORS from the browser. */
  hosted?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "ollama",
    label: "Ollama (local)",
    BackendAdapter: OllamaBackendAdapter,
    configFields: ["baseURL"],
    defaultBaseURL: "/ollama",
    defaultModel: "qwen2.5:3b",
    defaultModels: ["qwen2.5:3b", "llama3.1", "qwen2.5:7b", "mistral"],
  },
  {
    id: "openai",
    label: "OpenAI",
    BackendAdapter: OpenAIBackendAdapter,
    configFields: ["apiKey"],
    defaultModel: "gpt-4o-mini",
    defaultModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    hosted: true,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    BackendAdapter: AnthropicBackendAdapter,
    configFields: ["apiKey"],
    defaultModel: "claude-3-5-haiku-latest",
    defaultModels: ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
    hosted: true,
  },
  {
    id: "groq",
    label: "Groq",
    BackendAdapter: GroqBackendAdapter,
    configFields: ["apiKey"],
    defaultModel: "llama-3.1-8b-instant",
    defaultModels: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
    hosted: true,
  },
  {
    id: "gemini",
    label: "Gemini",
    BackendAdapter: GeminiBackendAdapter,
    configFields: ["apiKey"],
    defaultModel: "gemini-2.0-flash",
    defaultModels: ["gemini-2.0-flash", "gemini-1.5-flash"],
    hosted: true,
  },
  {
    id: "mistral",
    label: "Mistral",
    BackendAdapter: MistralBackendAdapter,
    configFields: ["apiKey"],
    defaultModel: "mistral-small-latest",
    defaultModels: ["mistral-small-latest", "mistral-large-latest"],
    hosted: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    BackendAdapter: OpenRouterBackendAdapter,
    configFields: ["apiKey"],
    defaultModel: "openai/gpt-4o-mini",
    defaultModels: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
    hosted: true,
  },
];

export function getProvider(id: string): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

// ── persisted per-provider config ─────────────────────────────────────────────

export interface ProviderConfig {
  providerId: string;
  /** Per-provider saved config keyed by provider id. */
  byProvider: Record<string, { apiKey?: string; baseURL?: string; model?: string }>;
}

const STORAGE_KEY = "composer.model";

export function defaultProviderConfig(): ProviderConfig {
  const byProvider: ProviderConfig["byProvider"] = {};
  for (const p of PROVIDERS) {
    byProvider[p.id] = { baseURL: p.defaultBaseURL, model: p.defaultModel };
  }
  return { providerId: PROVIDERS[0]!.id, byProvider };
}

export function loadProviderConfig(): ProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProviderConfig();
    const parsed = JSON.parse(raw) as ProviderConfig;
    // Merge over defaults so newly-added providers gain their seed config.
    const base = defaultProviderConfig();
    return {
      providerId: parsed.providerId ?? base.providerId,
      byProvider: { ...base.byProvider, ...parsed.byProvider },
    };
  } catch {
    return defaultProviderConfig();
  }
}

export function saveProviderConfig(cfg: ProviderConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* storage may be unavailable (private mode / tests) */
  }
}

/** The resolved config for the currently-selected provider. */
export function activeConfig(cfg: ProviderConfig): {
  provider: ProviderDef;
  apiKey: string;
  baseURL?: string;
  model: string;
} {
  const provider = getProvider(cfg.providerId);
  const saved = cfg.byProvider[provider.id] ?? {};
  return {
    provider,
    apiKey: saved.apiKey ?? "",
    baseURL: saved.baseURL ?? provider.defaultBaseURL,
    model: saved.model || provider.defaultModel || "",
  };
}

// ── bridge construction ────────────────────────────────────────────────────────

/** Build an ai.matey Bridge for the active provider config. */
export function buildBridge(cfg: ProviderConfig): { bridge: Bridge; model: string } {
  const { provider, apiKey, baseURL, model } = activeConfig(cfg);
  // apiKey is required by BackendAdapterConfig; Ollama ignores it, so "" is fine.
  // browserMode lets hosted providers (e.g. Anthropic) be called directly from a tab.
  const backendCfg: BackendAdapterConfig = {
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    browserMode: true,
  };
  const backend = new provider.BackendAdapter(backendCfg);
  const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
  return { bridge, model };
}

// ── public chat API ─────────────────────────────────────────────────────────────

// The Bridge is generic over its frontend adapter; with the default `Bridge` type the
// request/response collapse to `unknown`. We pin the request to the OpenAI request shape
// and read the responses through these OpenAI-shaped views (we always use the OpenAI
// frontend, so these are accurate).
interface OpenAIResponseView {
  choices?: Array<{ message?: { content?: string } }>;
}
interface OpenAIStreamChunkView {
  choices?: Array<{ delta?: { content?: string } }>;
}

/** One-shot completion. Returns the assistant's text. */
export async function chat(cfg: ProviderConfig, messages: ChatMessage[]): Promise<string> {
  const { bridge, model } = buildBridge(cfg);
  const res = (await bridge.chat({ model, messages })) as OpenAIResponseView;
  return res.choices?.[0]?.message?.content ?? "";
}

/** Streaming completion — yields text deltas as they arrive. */
export async function* streamChat(
  cfg: ProviderConfig,
  messages: ChatMessage[],
): AsyncGenerator<string> {
  const { bridge, model } = buildBridge(cfg);
  const stream = bridge.chatStream({ model, messages, stream: true });
  for await (const raw of stream) {
    const chunk = raw as OpenAIStreamChunkView;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}
