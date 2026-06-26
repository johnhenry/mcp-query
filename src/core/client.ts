// MCPClient — the public, framework-agnostic entry point. Owns the cache, the set
// of server connections (multiplexing), the router, and the host handlers. Exposes
// the imperative read/call/list API that the React hooks sit on top of.

import { MCPCache, type CachePatch } from "./cache.js";
import { ServerConnection, type ConnectionConfig } from "./connection.js";
import { Router } from "./router.js";
import { argsHash, type CacheKey } from "./keys.js";
import { capsTag, resourceTag, serverTag, type Tag } from "./tags.js";
import type { DevtoolsSink } from "../devtools/protocol.js";
import type { HostHandlers, MCPError, ServerState } from "./types.js";

export interface MCPClientConfig {
  servers: Record<string, ConnectionConfig>;
  handlers?: HostHandlers;
  /** scheme -> server for resource routing, e.g. { file: "fs", github: "github" }. */
  schemeMap?: Record<string, string>;
  cache?: MCPCache;
  devtools?: DevtoolsSink;
}

export interface ReadResourceOpts {
  server?: string;
  subscribe?: boolean;
  staleTime?: number;
  providesTags?: Tag[];
}

export interface CallToolOpts<A, R> {
  server?: string;
  invalidates?: Tag[] | ((args: A, result: R) => Tag[]);
  optimistic?: (args: A) => CachePatch[];
  signal?: AbortSignal;
  onProgress?: (p: { progress: number; total?: number }) => void;
}

export class MCPClient {
  readonly cache: MCPCache;
  private conns = new Map<string, ServerConnection>();
  private router: Router;
  private handlers: HostHandlers;
  private devtools?: DevtoolsSink;

  constructor(cfg: MCPClientConfig) {
    this.handlers = cfg.handlers ?? {};
    this.devtools = cfg.devtools;
    this.cache =
      cfg.cache ??
      new MCPCache({
        events: {
          // Ref-counted resources/subscribe: first observer subscribes, last unsubscribes.
          onSubscribe: (e) => this.maybeProtocolSubscribe(e.cacheKey, true),
          onUnsubscribe: (e) => this.maybeProtocolSubscribe(e.cacheKey, false),
          onInvalidate: (keys) => this.devtools?.emit({ type: "invalidate", keys }),
        },
      });

    for (const [name, conf] of Object.entries(cfg.servers)) {
      this.conns.set(
        name,
        new ServerConnection(name, conf, {
          cache: this.cache,
          handlers: this.handlers,
          onStateChange: (s, state, caps) => {
            this.devtools?.emit({ type: "server-state", server: s, state, capabilities: caps });
          },
          onCapabilitiesChanged: (s, kind) =>
            this.devtools?.emit({ type: "capabilities", server: s, kind }),
        }),
      );
    }
    this.router = new Router(this.conns, cfg.schemeMap);
  }

  /** Connect all servers. Failures are isolated — one dead server doesn't sink the rest. */
  async connect(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].map((c) => c.connect()));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].map((c) => c.close()));
  }

  connection(server: string): ServerConnection | undefined {
    return this.conns.get(server);
  }
  connections(): ServerConnection[] {
    return [...this.conns.values()];
  }
  serverState(server: string): ServerState {
    return this.conns.get(server)?.state ?? "idle";
  }

  // ── reads (useResource) ────────────────────────────────────────────────
  async readResource(uri: string, opts: ReadResourceOpts = {}): Promise<unknown> {
    const { server } = this.router.resolveResource(uri, opts.server);
    const conn = this.req(server);
    const key = { kind: "resource", server, uri } as const;
    this.cache.setFetching(key);
    try {
      const res = await conn.sdk.readResource({ uri });
      this.cache.write(key, res, {
        staleTime: opts.staleTime,
        // every resource auto-provides its URI tag (+ server tag for blunt invalidation)
        tags: [resourceTag(server, uri), serverTag(server), ...(opts.providesTags ?? [])],
      });
      if (opts.subscribe) await this.maybeProtocolSubscribe(key, true);
      return res;
    } catch (err) {
      this.cache.setError(key, this.toError(err, server, "protocol"));
      throw err;
    }
  }

  // ── calls (useTool) ───────────────────────────────────────────────────
  async callTool<A extends Record<string, unknown>, R = unknown>(
    name: string,
    args: A,
    opts: CallToolOpts<A, R> = {},
  ): Promise<R> {
    const { server, def } = this.router.resolveTool(name, opts.server);
    const conn = this.req(server);
    const readOnly = def.annotations?.readOnlyHint === true;

    const rollback = opts.optimistic ? this.cache.patch(opts.optimistic(args)) : undefined;
    try {
      const result = (await conn.sdk.callTool(
        { name: def.name, arguments: args },
        undefined,
        { signal: opts.signal, onprogress: opts.onProgress },
      )) as unknown as R & { isError?: boolean };

      // Tool-level error channel: surfaced as data, NOT thrown (mirrors GraphQL errors[]).
      if (result.isError) rollback?.();

      // readOnly tool results may be cached by (name,args) like a query.
      if (readOnly) {
        this.cache.write({ kind: "toolResult", server, tool: def.name, argsHash: argsHash(args) }, result, {
          tags: [serverTag(server)],
        });
      }

      // Declared invalidation. A well-behaved server also emits resources/updated,
      // which fires the same tags — so this is the fallback for silent servers.
      const tags = typeof opts.invalidates === "function" ? opts.invalidates(args, result) : opts.invalidates;
      if (tags?.length) this.cache.invalidateTags(tags);

      return result;
    } catch (err) {
      rollback?.();
      throw this.toError(err, server, "protocol");
    }
  }

  // ── capability lists (useTools / useResourceList / usePrompts) ───────────
  listTools(server: string) {
    return [...(this.conns.get(server)?.tools.values() ?? [])];
  }
  listResources(server: string) {
    return [...(this.conns.get(server)?.resources.values() ?? [])];
  }
  listPrompts(server: string) {
    return [...(this.conns.get(server)?.prompts.values() ?? [])];
  }
  capsTagFor = capsTag;

  async getPrompt(name: string, args: Record<string, unknown>, server?: string) {
    const { server: s } = this.router.resolveTool(name, server); // prompts share the resolve policy
    // MCP prompt arguments are string-valued; coerce so callers can pass numbers/bools.
    const stringArgs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]));
    return this.req(s).sdk.getPrompt({ name, arguments: stringArgs });
  }

  // ── internals ──────────────────────────────────────────────────────────
  /** Ref-counted resources/subscribe driven by cache subscriber count. */
  private async maybeProtocolSubscribe(key: CacheKey, want: boolean): Promise<void> {
    if (key.kind !== "resource") return;
    const { server, uri } = key;
    const conn = this.conns.get(server);
    if (!conn?.supports("resources.subscribe")) return;
    if (want) {
      await conn.sdk.subscribeResource({ uri }).catch(() => {});
      this.cache.setProtocolSubscribed(key, true);
    } else {
      await conn.sdk.unsubscribeResource({ uri }).catch(() => {});
      this.cache.setProtocolSubscribed(key, false);
    }
  }

  private req(server: string): ServerConnection {
    const c = this.conns.get(server);
    if (!c) throw new Error(`Unknown server "${server}"`);
    return c;
  }

  private toError(err: unknown, server: string, kind: MCPError["kind"]): MCPError {
    const e = err as { message?: string; code?: number; data?: unknown };
    return { kind, server, message: e?.message ?? String(err), code: e?.code, data: e?.data };
  }
}
