// MCPClient — the public, framework-agnostic entry point. Owns the cache, the set
// of server connections (multiplexing), the router, and the host handlers. Exposes
// the imperative read/call/list API that the React hooks sit on top of.

import { MCPCache, type CachePatch } from "./cache.js";
import { ServerConnection, type ConnectionConfig } from "./connection.js";
import { InteractionBroker } from "./interactions.js";
import { Router } from "./router.js";
import { argsHash, type CacheKey } from "./keys.js";
import { capsTag, resourceTag, serverTag, type Tag } from "./tags.js";
import type { DevtoolsSink } from "../devtools/protocol.js";
import type { HostHandlers, MCPError, ServerState } from "./types.js";

export interface MCPClientConfig {
  servers: Record<string, ConnectionConfig>;
  handlers?: HostHandlers;
  /** Human-in-the-loop broker; routes sampling + elicitation through one approval queue. */
  interactions?: InteractionBroker;
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
  /** The human-in-the-loop broker, if one was configured (read by useInteractions). */
  readonly interactions?: InteractionBroker;
  private conns = new Map<string, ServerConnection>();
  private router: Router;
  private handlers: HostHandlers;
  private devtools?: DevtoolsSink;
  private stateListeners = new Set<() => void>();
  private stateVersion = 0;

  constructor(cfg: MCPClientConfig) {
    this.handlers = cfg.handlers ?? {};
    this.devtools = cfg.devtools;
    this.interactions = cfg.interactions;
    // Mirror the broker's audit trail into devtools as host-call events.
    if (this.interactions && this.devtools) {
      this.interactions.addAuditSink((e) =>
        this.devtools?.emit({ type: "host-call", server: e.server, kind: e.type as "sampling" | "elicitation" }),
      );
    }
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
      // When a broker is present, sampling + elicitation are routed through it with
      // server context; other handlers (roots) pass through.
      const handlers = this.interactions
        ? this.interactions.handlersFor(name, this.handlers)
        : this.handlers;
      this.conns.set(
        name,
        new ServerConnection(name, conf, {
          cache: this.cache,
          handlers,
          onStateChange: (s, state, caps) => {
            this.bumpServerState();
            this.devtools?.emit({ type: "server-state", server: s, state, capabilities: caps });
          },
          onCapabilitiesChanged: (s, kind) =>
            this.devtools?.emit({ type: "capabilities", server: s, kind }),
          onLog: (s, entry) =>
            this.devtools?.emit({ type: "log", server: s, level: entry.level, data: entry.data }),
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
  listResourceTemplates(server: string) {
    return this.conns.get(server)?.templates ?? [];
  }
  listPrompts(server: string) {
    return [...(this.conns.get(server)?.prompts.values() ?? [])];
  }
  capsTagFor = capsTag;

  // ── server-state reactive store (useServerState) ─────────────────────────
  subscribeServerState = (fn: () => void): (() => void) => {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  };
  serverStateVersion = (): number => this.stateVersion;
  private bumpServerState(): void {
    this.stateVersion++;
    for (const fn of this.stateListeners) fn();
  }

  /** Set a server's logging verbosity (logging/setLevel). */
  setLogLevel(server: string, level: string): Promise<void> {
    return this.req(server).setLogLevel(level);
  }

  // ── readOnly tool as a cached query (useToolResult) ──────────────────────
  async queryTool<A extends Record<string, unknown>, R = unknown>(
    name: string,
    args: A,
    opts: { server?: string } = {},
  ): Promise<R> {
    const { server, def } = this.router.resolveTool(name, opts.server);
    const conn = this.req(server);
    const key = { kind: "toolResult", server, tool: def.name, argsHash: argsHash(args) } as const;
    this.cache.setFetching(key);
    try {
      const result = (await conn.sdk.callTool({ name: def.name, arguments: args })) as R;
      this.cache.write(key, result, { tags: [serverTag(server)] });
      return result;
    } catch (err) {
      this.cache.setError(key, this.toError(err, server, "protocol"));
      throw err;
    }
  }

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
