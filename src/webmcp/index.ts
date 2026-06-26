// EXPERIMENTAL · draft-tracking. Bridges between mcp-query and the emerging WebMCP
// browser API (`document.modelContext`, W3C Web ML CG). WebMCP is *tools-only*, is the
// inverse role (the page is the server, the in-browser agent is the client), and its
// discovery/invocation surface is still a moving target — so this lives outside the core
// and binds at the JS-object level (WebMCP is not JSON-RPC).
//
//  B) bridgeToWebMCP  — re-expose a backend MCP server's tools as WebMCP tools, so an
//     in-browser agent can drive your real servers *through* mcp-query (broker approval +
//     cache). This is the direction that genuinely earns its keep.
//  A) webMcpToolServer — consume a page's WebMCP tools as an ordinary mcp-query server.
//     Mostly here to unify the interfaces (and for cross-origin tool aggregation).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MCPClient } from "../core/client.js";
import type { ConnectionConfig } from "../core/connection.js";
import type { CacheKey } from "../core/keys.js";
import type { Tool } from "../core/types.js";

// ── minimal structural view of the WebMCP API (the real one is an evolving global) ──
export interface WebMCPToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface ModelContext {
  /** Register a tool; unregistered by aborting the passed signal (per the WebMCP draft). */
  registerTool(def: WebMCPToolDef, opts?: { signal?: AbortSignal }): unknown;
  /** Discovery/invocation are TODO in the spec; optional here. */
  getTools?(): WebMCPToolDef[] | Promise<WebMCPToolDef[]>;
  executeTool?(name: string, args: Record<string, unknown>): unknown | Promise<unknown>;
}

function defaultModelContext(): ModelContext {
  const mc = (globalThis as { document?: { modelContext?: ModelContext } }).document?.modelContext;
  if (!mc) throw new Error("No document.modelContext found — pass `modelContext` explicitly.");
  return mc;
}

// ───────────────────────────── B: mcp-query → WebMCP ─────────────────────────────

export interface BridgeOptions {
  modelContext?: ModelContext;
  /** WebMCP tool name. Default `${server}.${tool.name}`. */
  name?: (server: string, tool: Tool) => string;
  /** Filter which tools to expose. */
  include?: (tool: Tool) => boolean;
  /** Gate each agent invocation (e.g. confirm destructive tools). Default: allow. */
  confirm?: (ctx: { server: string; tool: Tool; args: Record<string, unknown> }) => boolean | Promise<boolean>;
  /** Map the MCP result before handing it back to the agent. Default: identity. */
  mapResult?: (result: unknown) => unknown;
}

/**
 * Expose a connected server's tools to an in-browser agent via WebMCP. Each `execute`
 * routes through `client.callTool` — so the broker (approval), cache, and invalidation all
 * apply. Stays in sync with `tools/list_changed`. Returns a `stop()` that unregisters all.
 */
export function bridgeToWebMCP(client: MCPClient, server: string, opts: BridgeOptions = {}): () => void {
  const mc = opts.modelContext ?? defaultModelContext();
  const nameOf = opts.name ?? ((s, t) => `${s}.${t.name}`);
  const registered = new Map<string, AbortController>();

  const sync = () => {
    const tools = client.listTools(server).filter((t) => opts.include?.(t) ?? true);
    const desired = new Map(tools.map((t) => [nameOf(server, t), t]));

    // remove tools that disappeared
    for (const [name, ctrl] of registered) {
      if (!desired.has(name)) {
        ctrl.abort();
        registered.delete(name);
      }
    }
    // add new tools
    for (const [name, tool] of desired) {
      if (registered.has(name)) continue;
      const ctrl = new AbortController();
      registered.set(name, ctrl);
      mc.registerTool(
        {
          name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
          execute: async (args) => {
            if (opts.confirm && !(await opts.confirm({ server, tool, args }))) {
              throw new Error(`"${name}" denied by host`);
            }
            const result = await client.callTool(`${server}.${tool.name}`, args);
            return opts.mapResult ? opts.mapResult(result) : result;
          },
        },
        { signal: ctrl.signal },
      );
    }
  };

  sync();
  // Re-sync whenever the server's tool catalog changes (tools/list_changed → cache write).
  const key: CacheKey = { kind: "toolList", server };
  const unsubscribe = client.cache.subscribe(key, sync);

  return () => {
    unsubscribe();
    for (const ctrl of registered.values()) ctrl.abort();
    registered.clear();
  };
}

// ───────────────────────────── A: WebMCP → mcp-query ─────────────────────────────

/**
 * Adapt a page's WebMCP tools as an ordinary mcp-query server (an in-memory MCP server
 * proxying to `getTools`/`executeTool`). Plug the result into `new MCPClient({ servers })`
 * to consume WebMCP tools with caching, the broker, and devtools — unifying both
 * directions on the same client. WebMCP is tools-only, so no resources/prompts appear.
 */
export function webMcpToolServer(modelContext?: ModelContext): ConnectionConfig {
  const mc = modelContext ?? defaultModelContext();
  return {
    transport: () => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "webmcp", version: "0.0.1" }, { capabilities: { tools: { listChanged: true } } });

      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = (await mc.getTools?.()) ?? [];
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object" },
          })),
        };
      });

      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        if (!mc.executeTool) throw new Error("this WebMCP host does not support executeTool");
        const out = await mc.executeTool(req.params.name, (req.params.arguments as Record<string, unknown>) ?? {});
        if (out && typeof out === "object" && "content" in out) return out as Record<string, unknown>;
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out ?? null) }] };
      });

      void server.connect(serverT);
      return clientT;
    },
  };
}
