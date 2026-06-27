// App state: one mcp-query MCPClient (multiplexing all inspected servers), a broker for
// human-in-the-loop, a devtools hub for the message log, and small signals the panels
// react to (active server, editable roots).

import { MCPClient, InteractionBroker } from "mcp-query";
import { DevtoolsHub } from "mcp-query/devtools";
import { WebSocketProxyTransport, type TargetSpec } from "./transport.js";

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

/** Connect (and register) a server. Everything is routed through the proxy uniformly. */
export async function connectServer(s: SavedServer): Promise<void> {
  await client.addServer(s.name, { transport: () => new WebSocketProxyTransport(proxyUrl, proxyToken, s) });
  activeServer.set(s.name);
}

export async function disconnectServer(name: string): Promise<void> {
  await client.removeServer(name);
  if (activeServer.get() === name) activeServer.set(client.connections()[0]?.name ?? "");
}
