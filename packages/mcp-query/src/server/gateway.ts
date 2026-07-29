// Gateway re-server — re-expose a client's aggregated, namespaced upstream servers as one
// MCP server. Pairs the downstream MCPClient with an SDK Server: the deployable backend
// artifact (a single MCP endpoint fronting many). Same in-memory-Server proxy pattern as
// src/webmcp/index.ts (webMcpToolServer), but aggregating the whole multiplexed client.
//
// Two serving entries share one handler implementation (buildGatewayServer, below):
//   createGateway        — 2025-era: a hand-constructed long-lived Server + transport.
//   createGatewayHandler — 2026-07-28-era: createMcpHandler's per-exchange Server
//                          instances, with subscriptions/listen fan-out via ServerNotifier.

import { createMcpHandler, Server, SdkError, SdkErrorCode, type CreateMcpHandlerOptions, type McpHttpHandler } from "@modelcontextprotocol/server";
import { MissingRequiredClientCapabilityError } from "@modelcontextprotocol/client";
import type { MCPClient } from "../core/client.js";
import { listKeyFor } from "../core/keys.js";
import type { CacheKey } from "../core/keys.js";

export interface GatewayOptions {
  name?: string;
  version?: string;
  /** Prefix tool/prompt names with `${server}.` so they're unambiguous. Default true. */
  namespace?: boolean;
  /** Exclude servers/items from the gateway. */
  filter?: (server: string, kind: "tool" | "resource" | "prompt", name: string) => boolean;
}

export interface GatewayHandlerOptions extends GatewayOptions {
  /** Passthrough to createMcpHandler — see its own TSDoc for each option. */
  legacy?: CreateMcpHandlerOptions["legacy"];
  onerror?: CreateMcpHandlerOptions["onerror"];
  responseMode?: CreateMcpHandlerOptions["responseMode"];
  keepAliveMs?: CreateMcpHandlerOptions["keepAliveMs"];
  maxSubscriptions?: CreateMcpHandlerOptions["maxSubscriptions"];
  bus?: CreateMcpHandlerOptions["bus"];
}

/**
 * Thrown in place of an upstream's raw `MissingRequiredClientCapability` (-32021): that
 * error's `requiredCapabilities` describes what mcp-query's own connection to the
 * *upstream* lacks, which is misleading if rethrown verbatim to the gateway's actual
 * consumer (a different hop, a different client capability set entirely).
 */
export class GatewayUpstreamCapabilityError extends Error {
  readonly code = -32004;
  constructor(
    readonly server: string,
    readonly requiredCapabilities: unknown,
    message?: string,
  ) {
    super(message ?? `upstream "${server}" requires a client capability the gateway's connection to it does not declare`);
    this.name = "GatewayUpstreamCapabilityError";
  }
}

const SEP = ".";

/** Translate a known upstream error into its gateway-facing form; rethrow anything else. */
async function viaUpstream<T>(server: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof MissingRequiredClientCapabilityError) {
      throw new GatewayUpstreamCapabilityError(server, e.requiredCapabilities, e.message);
    }
    throw e;
  }
}

/**
 * Build the (stateless, side-effect-free) request-handler wiring shared by both serving
 * entries below. Safe to call once per exchange — registers request handlers only, no
 * subscriptions or other cross-request state (that's each entry's own job, since a
 * per-request modern Server and a long-lived legacy Server manage it very differently).
 */
function buildGatewayServer(client: MCPClient, opts: GatewayOptions = {}): Server {
  const namespace = opts.namespace ?? true;
  const keep = (server: string, kind: "tool" | "resource" | "prompt", name: string) =>
    opts.filter?.(server, kind, name) ?? true;
  const qualify = (server: string, name: string) => (namespace ? `${server}${SEP}${name}` : name);
  const servers = () => client.connections().map((c) => c.name);

  const server = new Server(
    { name: opts.name ?? "mcp-query-gateway", version: opts.version ?? "0.1.0" },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } },
  );

  // SEP-2549 cache hints: the 2026-07-28 encode step reads `ttlMs`/`cacheScope` directly
  // off the object a handler returns. Harmless extra fields on legacy (2025) responses —
  // unaware clients ignore unknown result keys — so both serving entries share this.
  const hint = (key: CacheKey): { ttlMs?: number; cacheScope?: "public" | "private" } => {
    const e = client.cache.getSnapshot(key);
    if (!e || e.status !== "success") return {};
    const ttlMs = Math.max(0, Math.round(e.staleTime - (Date.now() - e.updatedAt)));
    return { ttlMs, ...(e.scope ? { cacheScope: e.scope } : {}) };
  };
  /** Combine per-server hints for an aggregated list: the minimum remaining ttl (the
   * soonest any contributing entry goes stale), private if any contributor is private. */
  const listHint = (ss: string[], what: "tools" | "resources" | "prompts") => {
    const hints = ss.map((s) => hint(listKeyFor(s, what)));
    const known = hints.filter((h) => h.ttlMs !== undefined);
    if (!known.length) return {};
    const ttlMs = Math.min(...known.map((h) => h.ttlMs!));
    const cacheScope = hints.some((h) => h.cacheScope === "private") ? ("private" as const) : undefined;
    return { ttlMs, ...(cacheScope ? { cacheScope } : {}) };
  };
  const findResourceServer = (uri: string): string | undefined =>
    servers().find((s) => client.listResources(s).some((r) => r.uri === uri));

  // ── tools ──
  server.setRequestHandler("tools/list", () => {
    const ss = servers();
    return {
      tools: ss.flatMap((s) => client.listTools(s).filter((t) => keep(s, "tool", t.name)).map((t) => ({ ...t, name: qualify(s, t.name) }))),
      ...listHint(ss, "tools"),
    };
  });
  server.setRequestHandler("tools/call", async (req) => {
    const [s, tool] = split(req.params.name, servers(), namespace);
    // Forward the caller's _meta (tenant/principal/progressToken) so context traverses
    // the gateway — without this, multi-tenant _meta dies at the gate.
    const meta = req.params._meta as Record<string, unknown> | undefined;
    return (await viaUpstream(s, () =>
      client.callTool(`${s}.${tool}`, (req.params.arguments as Record<string, unknown>) ?? {}, meta ? { context: { meta } } : {}),
    )) as never;
  });

  // ── resources (URIs are global; route reads back through the client's resolver) ──
  server.setRequestHandler("resources/list", () => {
    const ss = servers();
    return {
      resources: ss.flatMap((s) => client.listResources(s).filter((r) => keep(s, "resource", r.uri))),
      ...listHint(ss, "resources"),
    };
  });
  server.setRequestHandler("resources/templates/list", () => ({
    resourceTemplates: servers().flatMap((s) => client.listResourceTemplates(s)),
  }));
  server.setRequestHandler("resources/read", async (req) => {
    const s = findResourceServer(req.params.uri);
    const result = (await (s
      ? viaUpstream(s, () => client.readResource(req.params.uri))
      : client.readResource(req.params.uri))) as Record<string, unknown>;
    return { ...result, ...(s ? hint({ kind: "resource", server: s, uri: req.params.uri }) : {}) } as never;
  });

  // ── prompts ──
  server.setRequestHandler("prompts/list", () => {
    const ss = servers();
    return {
      prompts: ss.flatMap((s) => client.listPrompts(s).filter((p) => keep(s, "prompt", p.name)).map((p) => ({ ...p, name: qualify(s, p.name) }))),
      ...listHint(ss, "prompts"),
    };
  });
  server.setRequestHandler("prompts/get", async (req) => {
    const [s, name] = split(req.params.name, servers(), namespace);
    const meta = req.params._meta as Record<string, unknown> | undefined;
    return (await viaUpstream(s, () =>
      client.getPrompt(name, (req.params.arguments as Record<string, unknown>) ?? {}, s, meta ? { context: { meta } } : {}),
    )) as never;
  });

  return server;
}

/**
 * A long-lived, 2025-era gateway: one Server instance served over a transport you connect
 * yourself (`gate.server.connect(transport)`). For modern (2026-07-28) HTTP serving, use
 * `createGatewayHandler` instead — a hand-constructed Server + transport only speaks the
 * legacy wire shape.
 */
export function createGateway(client: MCPClient, opts: GatewayOptions = {}): Server {
  const server = buildGatewayServer(client, opts);

  // ── live list_changed propagation ──
  // Swallow "not connected": `server` is only wired to a transport if the caller chooses to
  // serve it — library-mode callers use `client` directly and never connect `server` at all
  // (see mcp-gate's README). A capability change on the client (a new/removed upstream, or
  // an upstream's own list_changed) must not throw/reject just because nobody's listening.
  const notifyIfConnected = (send: () => Promise<void>) =>
    send().catch((e) => {
      if (!(e instanceof SdkError) || e.code !== SdkErrorCode.NotConnected) throw e;
    });
  client.subscribeCapabilities((_s, kind) => {
    if (kind === "tools") void notifyIfConnected(() => server.sendToolListChanged());
    else if (kind === "resources") void notifyIfConnected(() => server.sendResourceListChanged());
    else void notifyIfConnected(() => server.sendPromptListChanged());
  });

  return server;
}

/**
 * A modern (2026-07-28) HTTP gateway handler: `handler.fetch(request)` serves both eras
 * (dual-era, per `createMcpHandler`'s own default `legacy: 'stateless'`). Unlike
 * `createGateway`, there is no single long-lived `Server` — `createMcpHandler` builds a
 * fresh one per exchange via the factory, so list_changed fan-out to modern
 * `subscriptions/listen` consumers goes through the handler's own `notify` facade
 * instead (a per-exchange Server is discarded before any listen stream could see
 * `sendXListChanged()` on it). Call `handler.close()` to unsubscribe from the client and
 * tear down the modern leg — a leaked subscription is the same class of bug the
 * NotConnected fix above addresses for `createGateway`, just for a different lifecycle.
 */
export function createGatewayHandler(client: MCPClient, opts: GatewayHandlerOptions = {}): McpHttpHandler {
  const handler = createMcpHandler(() => buildGatewayServer(client, opts), {
    legacy: opts.legacy,
    onerror: opts.onerror,
    responseMode: opts.responseMode,
    keepAliveMs: opts.keepAliveMs,
    maxSubscriptions: opts.maxSubscriptions,
    bus: opts.bus,
  });
  const unsubscribe = client.subscribeCapabilities((_s, kind) => {
    if (kind === "tools") handler.notify.toolsChanged();
    else if (kind === "resources") handler.notify.resourcesChanged();
    else handler.notify.promptsChanged();
  });
  return { ...handler, close: async () => { unsubscribe(); await handler.close(); } };
}

/** Resolve a (possibly namespaced) name back to [server, bareName]. */
function split(name: string, servers: string[], namespace: boolean): [string, string] {
  if (namespace && name.includes(SEP)) {
    const i = name.indexOf(SEP);
    const s = name.slice(0, i);
    if (servers.includes(s)) return [s, name.slice(i + 1)];
  }
  // not namespaced (or single server): find the unique owner
  return [servers[0] ?? "", name];
}
