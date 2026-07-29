// Gateway re-server — re-expose a client's aggregated, namespaced upstream servers as one
// MCP server. Pairs the downstream MCPClient with an SDK Server: the deployable backend
// artifact (a single MCP endpoint fronting many). Same in-memory-Server proxy pattern as
// src/webmcp/index.ts (webMcpToolServer), but aggregating the whole multiplexed client.
//
// Era note (2026-07-28): a hand-constructed `Server` + transport serves the 2025
// era only. To serve the modern revision over HTTP, wrap the gateway in the SDK's
// `createMcpHandler`:
//
//   import { createMcpHandler } from "@modelcontextprotocol/server";
//   const handler = createMcpHandler(() => createGateway(client));
//   // handler.fetch(request) — dual-era Streamable HTTP endpoint
//
// (Modern-serving concerns — listen-stream fan-out for upstream list_changed,
// stamping ttlMs/cacheScope from the client's cache — are tracked in
// https://github.com/johnhenry/mcp-query/issues/15.)

import { Server, SdkError, SdkErrorCode } from "@modelcontextprotocol/server";
import type { MCPClient } from "../core/client.js";

export interface GatewayOptions {
  name?: string;
  version?: string;
  /** Prefix tool/prompt names with `${server}.` so they're unambiguous. Default true. */
  namespace?: boolean;
  /** Exclude servers/items from the gateway. */
  filter?: (server: string, kind: "tool" | "resource" | "prompt", name: string) => boolean;
}

const SEP = ".";

export function createGateway(client: MCPClient, opts: GatewayOptions = {}): Server {
  const namespace = opts.namespace ?? true;
  const keep = (server: string, kind: "tool" | "resource" | "prompt", name: string) =>
    opts.filter?.(server, kind, name) ?? true;
  const qualify = (server: string, name: string) => (namespace ? `${server}${SEP}${name}` : name);
  const servers = () => client.connections().map((c) => c.name);

  const server = new Server(
    { name: opts.name ?? "mcp-query-gateway", version: opts.version ?? "0.1.0" },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } },
  );

  // ── tools ──
  server.setRequestHandler("tools/list", () => ({
    tools: servers().flatMap((s) =>
      client.listTools(s).filter((t) => keep(s, "tool", t.name)).map((t) => ({ ...t, name: qualify(s, t.name) })),
    ),
  }));
  server.setRequestHandler("tools/call", async (req) => {
    const [s, tool] = split(req.params.name, servers(), namespace);
    // Forward the caller's _meta (tenant/principal/progressToken) so context traverses
    // the gateway — without this, multi-tenant _meta dies at the gate.
    const meta = req.params._meta as Record<string, unknown> | undefined;
    return (await client.callTool(
      `${s}.${tool}`,
      (req.params.arguments as Record<string, unknown>) ?? {},
      meta ? { context: { meta } } : {},
    )) as never;
  });

  // ── resources (URIs are global; route reads back through the client's resolver) ──
  server.setRequestHandler("resources/list", () => ({
    resources: servers().flatMap((s) => client.listResources(s).filter((r) => keep(s, "resource", r.uri))),
  }));
  server.setRequestHandler("resources/templates/list", () => ({
    resourceTemplates: servers().flatMap((s) => client.listResourceTemplates(s)),
  }));
  server.setRequestHandler("resources/read", async (req) => {
    return (await client.readResource(req.params.uri)) as never;
  });

  // ── prompts ──
  server.setRequestHandler("prompts/list", () => ({
    prompts: servers().flatMap((s) =>
      client.listPrompts(s).filter((p) => keep(s, "prompt", p.name)).map((p) => ({ ...p, name: qualify(s, p.name) })),
    ),
  }));
  server.setRequestHandler("prompts/get", async (req) => {
    const [s, name] = split(req.params.name, servers(), namespace);
    const meta = req.params._meta as Record<string, unknown> | undefined;
    return (await client.getPrompt(
      name,
      (req.params.arguments as Record<string, unknown>) ?? {},
      s,
      meta ? { context: { meta } } : {},
    )) as never;
  });

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
