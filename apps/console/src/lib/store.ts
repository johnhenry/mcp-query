// Console app state. One mcp-query MCPClient multiplexes every connected server; the
// nav/tool/resource/prompt panels read its capability lists and call into it. Unlike the
// inspector (a protocol debugger) there is no message log or composer here — the
// DevtoolsHub is kept only so panels can cheaply re-render on protocol activity.

import { MCPClient } from "mcp-query";
import { DevtoolsHub } from "mcp-query/devtools";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { WebSocketProxyTransport, type TargetSpec } from "@app-shared/transport";
import { BrowserOAuthProvider } from "@app-shared/oauth";

const params = new URLSearchParams(location.search);
export const proxyToken = params.get("proxyToken") ?? "";
export const proxyUrl = `ws://${location.hostname}:${params.get("proxyPort") ?? 6280}`;

// ── a minimal observable ──
function signal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => { value = v; for (const l of listeners) l(); },
    subscribe: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

/** The server whose capabilities the operator is currently using. */
export const activeServer = signal("");
/** Roots advertised to servers that ask (file:/// is a safe default). */
export const roots = signal<Array<{ uri: string; name?: string }>>([{ uri: "file:///" }]);

export const hub = new DevtoolsHub(500);
export const client = new MCPClient({
  servers: {},
  devtools: hub,
  handlers: { roots: () => roots.get() },
  clientInfo: { name: "mcp-console", version: "0.0.1", title: "MCP Console" },
});

export interface SavedServer extends TargetSpec {
  name: string;
}

// ── persisted server book (localStorage) ─────────────────────────────────────
const BOOK_KEY = "mcp-console-servers";

export function savedServers(): SavedServer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BOOK_KEY) ?? "[]");
    return Array.isArray(raw) ? (raw as SavedServer[]) : [];
  } catch {
    return [];
  }
}

export function rememberServer(s: SavedServer): void {
  const book = savedServers().filter((x) => x.name !== s.name);
  book.push(s);
  localStorage.setItem(BOOK_KEY, JSON.stringify(book));
  serverBook.set(book);
}

export function forgetServer(name: string): void {
  const book = savedServers().filter((x) => x.name !== name);
  localStorage.setItem(BOOK_KEY, JSON.stringify(book));
  serverBook.set(book);
}

/** Observable mirror of the persisted book so the header re-renders on save/forget. */
export const serverBook = signal<SavedServer[]>(savedServers());

// ── OAuth (direct browser-side http/sse) ─────────────────────────────────────
const providers = new Map<string, OAuthClientProvider>();
const PENDING = "mcp-console-pending-auth";

function provider(name: string): OAuthClientProvider {
  let p = providers.get(name);
  if (!p) { p = new BrowserOAuthProvider(name); providers.set(name, p); }
  return p;
}

function directTransport(spec: SavedServer, p: OAuthClientProvider): () => Transport {
  const url = new URL(spec.url!);
  return () =>
    spec.transport === "sse"
      ? new SSEClientTransport(url, { authProvider: p })
      : new StreamableHTTPClientTransport(url, { authProvider: p });
}

/** Connect (and register) a server — via the WS proxy, or directly for browser OAuth. */
export async function connectServer(s: SavedServer): Promise<void> {
  sessionStorage.setItem(`mcp-console-spec:${s.name}`, JSON.stringify(s));
  if (s.direct && (s.transport === "http" || s.transport === "sse")) {
    const make = directTransport(s, provider(s.name));
    sessionStorage.setItem(PENDING, JSON.stringify(s)); // survive an auth redirect
    await client.addServer(s.name, { transport: make }); // may navigate away to the IdP
    sessionStorage.removeItem(PENDING);
  } else {
    await client.addServer(s.name, { transport: () => new WebSocketProxyTransport(proxyUrl, proxyToken, s) });
  }
  activeServer.set(s.name);
}

/** After an OAuth redirect back to the app (?code=…), exchange the code and connect. */
export async function resumeIfAuthCallback(): Promise<void> {
  const code = new URLSearchParams(location.search).get("code");
  const pending = sessionStorage.getItem(PENDING);
  if (!code || !pending) return;
  const spec = JSON.parse(pending) as SavedServer;
  const make = directTransport(spec, provider(spec.name));
  try {
    const t = make();
    await (t as unknown as { finishAuth(code: string): Promise<void> }).finishAuth(code);
    await t.close().catch(() => {});
    sessionStorage.removeItem(PENDING);
    cleanAuthParamsFromUrl();
    await client.addServer(spec.name, { transport: make });
    activeServer.set(spec.name);
  } catch (e) {
    console.error("OAuth resume failed:", e);
    sessionStorage.removeItem(PENDING);
    cleanAuthParamsFromUrl();
  }
}

function cleanAuthParamsFromUrl(): void {
  const keep = new URLSearchParams();
  const cur = new URLSearchParams(location.search);
  for (const k of ["proxyToken", "proxyPort"]) if (cur.get(k)) keep.set(k, cur.get(k)!);
  history.replaceState({}, "", location.pathname + (keep.toString() ? `?${keep}` : ""));
}

export async function disconnectServer(name: string): Promise<void> {
  await client.removeServer(name);
  if (activeServer.get() === name) activeServer.set(client.connections()[0]?.name ?? "");
}
