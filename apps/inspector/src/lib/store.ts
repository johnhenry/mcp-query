// App state: one mcp-query MCPClient (multiplexing all inspected servers), a broker for
// human-in-the-loop, a devtools hub for the message log, and small signals the panels
// react to (active server, editable roots).

import { MCPClient, InteractionBroker, type AuthStep } from "@johnhenry/mcp-query";
import { DevtoolsHub } from "@johnhenry/mcp-query/devtools";
import { StreamableHTTPClientTransport, SSEClientTransport, type Transport, type OAuthClientProvider } from "@modelcontextprotocol/client";
import { mcpAppsExtensions } from "@johnhenry/mcp-query-ui";
import { WebSocketProxyTransport, type TargetSpec } from "./transport.js";
import { createInstrumentedProvider } from "./oauth.js";
import { appendStep, clearSteps } from "./oauthSteps.js";
import { completeAuth } from "./oauthResume.js";
import { governance } from "./governed.js";

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
  interceptors: [governance.interceptor], // Apps tab governed mode: holds only governed app-initiated calls, passes everything else
  extensions: mcpAppsExtensions(), // advertise io.modelcontextprotocol/ui so servers expose MCP Apps
  handlers: { roots: () => roots.get() }, // advertised + answered on demand
  clientInfo: { name: "mcp-inspector", version: "0.0.1", title: "MCP Inspector" },
});

export interface SavedServer extends TargetSpec {
  name: string;
}

/** Instrumented OAuth providers per server, so the debugger panel can read their steps. */
export type InstrumentedAuth = OAuthClientProvider & {
  authSteps: () => readonly AuthStep[];
  authNote: (member: string, detail?: unknown) => void;
  prepare?: () => Promise<unknown>;
};
export const authProviders = new Map<string, InstrumentedAuth>();
const PENDING = "mcp-pending-auth";

function instrumentedProvider(name: string): InstrumentedAuth {
  const provider = createInstrumentedProvider(name, (step) => {
    appendStep(name, step); // survives the redirect to the authorization server
    hub.emit({ type: "auth", member: `${name}.${step.member}`, phase: step.phase, detail: step.detail });
  }) as unknown as InstrumentedAuth;
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
    const provider = instrumentedProvider(s.name);
    await provider.prepare?.(); // decide CIMD vs DCR (and record why) before the SDK runs
    const make = directTransport(s, provider);
    sessionStorage.setItem(PENDING, JSON.stringify(s)); // survive the auth redirect
    await client.addServer(s.name, { transport: make }); // may navigate away to the IdP
    sessionStorage.removeItem(PENDING); // reached only when no redirect was needed
  } else {
    const make = () => new WebSocketProxyTransport(proxyUrl, proxyToken, s);
    await client.addServer(s.name, { transport: make });
  }
  activeServer.set(s.name);
}

/** After an OAuth redirect back to the app (?code=…), exchange the code and connect. */
export async function resumeIfAuthCallback(): Promise<void> {
  const code = new URLSearchParams(location.search).get("code");
  const pending = sessionStorage.getItem(PENDING);
  if (!code || !pending) return;
  const spec = JSON.parse(pending) as SavedServer;
  const provider = instrumentedProvider(spec.name);
  await provider.prepare?.(); // so the stored client is still recognised as CIMD (its id is the document URL)
  const make = directTransport(spec, provider);
  try {
    const t = make();
    await completeAuth(t as unknown as Parameters<typeof completeAuth>[0], provider, new URLSearchParams(location.search)); // code → tokens, iss checked
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
  authProviders.get(name)?.invalidateCredentials?.("discovery"); // show a fresh discovery in the stepper
  clearSteps(name); // a re-authorization starts a fresh step log
  await client.removeServer(name).catch(() => {});
  if (spec) await connectServer(spec);
}

function cleanAuthParamsFromUrl(): void {
  const keep = new URLSearchParams();
  const cur = new URLSearchParams(location.search);
  if (cur.get("proxyToken")) keep.set("proxyToken", cur.get("proxyToken")!);
  history.replaceState({}, "", location.pathname + (keep.toString() ? `?${keep}` : ""));
}

/** Called with a server's name when it is disconnected (the governed-mode gate for it is closed). */
export const disconnectHooks = new Set<(name: string) => void>();

export async function disconnectServer(name: string): Promise<void> {
  for (const h of disconnectHooks) h(name);
  await client.removeServer(name);
  if (activeServer.get() === name) activeServer.set(client.connections()[0]?.name ?? "");
}
