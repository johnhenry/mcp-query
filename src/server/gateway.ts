// Gateway re-server — re-expose a client's aggregated, namespaced upstream servers as one
// MCP server. Pairs the downstream MCPClient with an SDK Server: the deployable backend
// artifact (a single MCP endpoint fronting many). Same in-memory-Server proxy pattern as
// src/webmcp/index.ts (webMcpToolServer), but aggregating the whole multiplexed client.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
    { name: opts.name ?? "mcp-query-gateway", version: opts.version ?? "0.0.1" },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } },
  );

  // ── tools ──
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: servers().flatMap((s) =>
      client.listTools(s).filter((t) => keep(s, "tool", t.name)).map((t) => ({ ...t, name: qualify(s, t.name) })),
    ),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const [s, tool] = split(req.params.name, servers(), namespace);
    return (await client.callTool(`${s}.${tool}`, (req.params.arguments as Record<string, unknown>) ?? {})) as never;
  });

  // ── resources (URIs are global; route reads back through the client's resolver) ──
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: servers().flatMap((s) => client.listResources(s).filter((r) => keep(s, "resource", r.uri))),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: servers().flatMap((s) => client.listResourceTemplates(s)),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return (await client.readResource(req.params.uri)) as never;
  });

  // ── prompts ──
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: servers().flatMap((s) =>
      client.listPrompts(s).filter((p) => keep(s, "prompt", p.name)).map((p) => ({ ...p, name: qualify(s, p.name) })),
    ),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const [s, name] = split(req.params.name, servers(), namespace);
    return (await client.getPrompt(name, (req.params.arguments as Record<string, unknown>) ?? {}, s)) as never;
  });

  // ── live list_changed propagation ──
  client.subscribeCapabilities((_s, kind) => {
    if (kind === "tools") void server.sendToolListChanged();
    else if (kind === "resources") void server.sendResourceListChanged();
    else void server.sendPromptListChanged();
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
