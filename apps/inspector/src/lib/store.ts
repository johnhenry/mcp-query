// App state: one mcp-query MCPClient (multiplexing all inspected servers), a broker for
// human-in-the-loop, a devtools hub for the message log, and small signals the panels
// react to (active server, editable roots).

import { MCPClient, InteractionBroker, instrumentAuthProvider, type AuthStep } from "mcp-query";
import { DevtoolsHub } from "mcp-query/devtools";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { WebSocketProxyTransport, type TargetSpec } from "./transport.js";
import { BrowserOAuthProvider } from "./oauth.js";

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

export const activeServer = signal("");
/** Editable roots advertised to servers (the roots editor mutates this). */
export const roots = signal<Array<{ uri: string; name?: string }>>([{ uri: "file:///" }]);

export const hub = new DevtoolsHub(2000);
export const broker = new InteractionBroker({ manualSampling: true }); // a human authors sampling replies
export const client = new MCPClient({
  servers: {},
  interactions: broker,
  devtools: hub,
  handlers: { roots: () => roots.get() }, // advertised + answered on demand
  clientInfo: { name: "mcp-inspector", version: "0.0.1", title: "MCP Inspector" },
});

export interface SavedServer extends TargetSpec {
  name: string;
}

/** Instrumented OAuth providers per server, so the debugger panel can read their steps. */
export type InstrumentedAuth = OAuthClientProvider & { authSteps: () => readonly AuthStep[] };
export const authProviders = new Map<string, InstrumentedAuth>();
const PENDING = "mcp-pending-auth";

function instrumentedProvider(name: string): InstrumentedAuth {
  const base = new BrowserOAuthProvider(name);
  const provider = instrumentAuthProvider(base, (step) =>
    hub.emit({ type: "auth", member: `${name}.${step.member}`, phase: step.phase, detail: step.detail }),
  ) as InstrumentedAuth;
  authProviders.set(name, provider);
  return provider;
}

/** A browser-side transport factory for direct http/sse (OAuth runs + is observed here). */
function directTransport(spec: SavedServer, provider: OAuthClientProvider): () => Transport {
  const url = new URL(spec.url!);
  return () =>
    spec.transport === "sse"
      ? new SSEClientTransport(url, { authProvider: provider })
      : new StreamableHTTPClientTransport(url, { authProvider: provider });
}

/** Connect (and register) a server — via the proxy, or directly for browser-side OAuth. */
export async function connectServer(s: SavedServer): Promise<void> {
  sessionStorage.setItem(`mcp-spec:${s.name}`, JSON.stringify(s)); // for re-auth / resume
  if (s.direct && (s.transport === "http" || s.transport === "sse")) {
    const make = directTransport(s, instrumentedProvider(s.name));
    sessionStorage.setItem(PENDING, JSON.stringify(s)); // survive the auth redirect
    await client.addServer(s.name, { transport: make }); // may navigate away to the IdP
    sessionStorage.removeItem(PENDING); // reached only when no redirect was needed
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
  const make = directTransport(spec, instrumentedProvider(spec.name));
  try {
    const t = make();
    await (t as unknown as { finishAuth(code: string): Promise<void> }).finishAuth(code); // code → tokens
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

/** Force a fresh OAuth flow for a server (clears tokens, reconnects). */
export async function reauthServer(name: string): Promise<void> {
  const spec = JSON.parse(sessionStorage.getItem(`mcp-spec:${name}`) ?? "null") as SavedServer | null;
  authProviders.get(name)?.invalidateCredentials?.("tokens");
  await client.removeServer(name).catch(() => {});
  if (spec) await connectServer(spec);
}

function cleanAuthParamsFromUrl(): void {
  const keep = new URLSearchParams();
  const cur = new URLSearchParams(location.search);
  if (cur.get("proxyToken")) keep.set("proxyToken", cur.get("proxyToken")!);
  history.replaceState({}, "", location.pathname + (keep.toString() ? `?${keep}` : ""));
}

export async function disconnectServer(name: string): Promise<void> {
  await client.removeServer(name);
  if (activeServer.get() === name) activeServer.set(client.connections()[0]?.name ?? "");
}
