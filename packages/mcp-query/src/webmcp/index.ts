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

// One package per InMemoryTransport pair: both ends come from the SERVER package
// here, since the page-side Server is the piece we construct.
import { InMemoryTransport, Server, type CallToolResult } from "@modelcontextprotocol/server";
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

/**
 * A tool as returned by `getTools()`. Native WebMCP / `@mcp-b/global` 5.1 return descriptors
 * (`RegisteredTool` in `@mcp-b/webmcp-types`): no `execute`, and `inputSchema` is a JSON
 * Schema object *or* (Chrome 149-153) a serialized JSON string. Older/hand-rolled hosts
 * return the registered definitions, which carry `execute`.
 */
export interface WebMCPToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown> | string;
  execute?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  [extra: string]: unknown;
}

export interface ModelContext {
  /** Register a tool; unregistered by aborting the passed signal (per the WebMCP draft). */
  registerTool(def: WebMCPToolDef, opts?: { signal?: AbortSignal }): unknown;
  /** Discovery (`getTools`) is in the spec; tolerated as absent here. */
  getTools?(): WebMCPToolInfo[] | Promise<WebMCPToolInfo[]>;
  /**
   * Native/Chromium + `@mcp-b/global` 5.1: `executeTool(tool: RegisteredTool, inputArguments: string)`
   * resolving a JSON string (or `null`). Legacy shape still accepted: `executeTool(name, args)`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeTool?(tool: any, input: any, options?: { signal?: AbortSignal }): unknown | Promise<unknown>;
}

/** Deprecated `navigator.modelContextTesting` shim: `executeTool(name, inputArgsJson)` → JSON string | null. */
interface ModelContextTesting {
  executeTool(toolName: string, inputArgsJson: string): unknown | Promise<unknown>;
}

function defaultModelContext(): ModelContext {
  const g = globalThis as {
    document?: { modelContext?: ModelContext };
    navigator?: { modelContext?: ModelContext };
  };
  const mc = g.document?.modelContext ?? g.navigator?.modelContext;
  if (!mc) throw new Error("No document.modelContext found — pass `modelContext` explicitly.");
  return mc;
}

function modelContextTesting(): ModelContextTesting | undefined {
  return (globalThis as { navigator?: { modelContextTesting?: ModelContextTesting } }).navigator?.modelContextTesting;
}

/** `inputSchema` may be an object or (older Chrome) a JSON string. */
function normalizeSchema(schema: unknown): { type: "object" } {
  let v = schema;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      v = undefined;
    }
  }
  return (v && typeof v === "object" ? v : { type: "object" }) as { type: "object" };
}

/** Native executeTool resolves a JSON string (or null); legacy hosts return the value directly. */
function toCallToolResult(out: unknown, parseJsonString: boolean): CallToolResult {
  let v = out;
  if (parseJsonString && typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      /* not JSON: keep the raw string */
    }
  }
  if (v && typeof v === "object" && "content" in v) return v as CallToolResult;
  return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v ?? null) }] };
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
      const reg = mc.registerTool(
        {
          name,
          description: tool.description ?? "",
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
      // Native registerTool returns Promise<void> and rejects (e.g. duplicate name); don't leak it.
      if (reg && typeof (reg as Promise<unknown>).catch === "function") (reg as Promise<unknown>).catch(() => {});
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
      const server = new Server({ name: "webmcp", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });

      server.setRequestHandler("tools/list", async () => {
        const tools = (await mc.getTools?.()) ?? [];
        return {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: normalizeSchema(t.inputSchema),
          })),
        };
      });

      server.setRequestHandler("tools/call", async (req): Promise<CallToolResult> => {
        const name = req.params.name;
        const args = (req.params.arguments as Record<string, unknown>) ?? {};
        const tool = ((await mc.getTools?.()) ?? []).find((t) => t.name === name);

        // Legacy shape: the host's tools carry `execute`, and `executeTool(name, args)` (if any) takes a name.
        if (tool && typeof tool.execute === "function") {
          const out = mc.executeTool ? await mc.executeTool(name, args) : await tool.execute(args);
          return toCallToolResult(out, false);
        }
        // Native / @mcp-b/global 5.1: executeTool(RegisteredTool, JSON string) → JSON string | null.
        if (tool && mc.executeTool) {
          return toCallToolResult(await mc.executeTool(tool, JSON.stringify(args)), true);
        }
        // Deprecated testing shim: executeTool(name, JSON string).
        const testing = modelContextTesting();
        if (testing?.executeTool) {
          return toCallToolResult(await testing.executeTool(name, JSON.stringify(args)), true);
        }
        if (!tool && mc.executeTool) {
          // Unknown to getTools (host without discovery): try the legacy name form.
          return toCallToolResult(await mc.executeTool(name, args), false);
        }
        throw new Error(tool ? "this WebMCP host does not support executeTool" : `unknown WebMCP tool "${name}"`);
      });

      void server.connect(serverT);
      return clientT;
    },
  };
}
