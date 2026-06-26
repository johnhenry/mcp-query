// MCPClient — the public, framework-agnostic entry point. Owns the cache, the set
// of server connections (multiplexing), the router, and the host handlers. Exposes
// the imperative read/call/list API that the React hooks sit on top of.

import { MCPCache, type CachePatch } from "./cache.js";
import { ServerConnection, type ConnectionConfig } from "./connection.js";
import { InteractionBroker } from "./interactions.js";
import type { TrafficEvent } from "./instrument.js";
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
  /** Retry count for *reads* (resource reads + tool queries are safe to retry). Default 0. */
  retry?: number;
}

/** Per-request timeout knobs (mirrors the SDK's RequestOptions), exposed like Inspector. */
export interface RequestTimeoutOpts {
  timeout?: number;
  resetTimeoutOnProgress?: boolean;
  maxTotalTimeout?: number;
}

export interface ReadResourceOpts {
  server?: string;
  subscribe?: boolean;
  staleTime?: number;
  /** Extra tags this entry provides — a list, or a function of the result (entity layer). */
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  requestOptions?: RequestTimeoutOpts;
}

export interface QueryToolOpts {
  server?: string;
  /** Extra tags this cached result provides — list or function of result (entity layer). */
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  requestOptions?: RequestTimeoutOpts;
}

export interface CallToolOpts<A, R> {
  server?: string;
  invalidates?: Tag[] | ((args: A, result: R) => Tag[]);
  optimistic?: (args: A) => CachePatch[];
  signal?: AbortSignal;
  onProgress?: (p: { progress: number; total?: number }) => void;
  requestOptions?: RequestTimeoutOpts;
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
  private retryCount = 0;

  constructor(cfg: MCPClientConfig) {
    this.handlers = cfg.handlers ?? {};
    this.devtools = cfg.devtools;
    this.interactions = cfg.interactions;
    this.retryCount = cfg.retry ?? 0;
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
          onUnsubscribe: (e) => {
            this.maybeProtocolSubscribe(e.cacheKey, false);
            this.cache.abortInflight(e.cacheKey); // cancel a fetch nobody is watching anymore
          },
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
          onMessage: this.devtools ? (s, ev) => this.onTraffic(s, ev) : undefined,
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

    // De-dupe: concurrent reads of the same key share one in-flight request.
    const existing = this.cache.inflight(key);
    if (existing) return existing;

    this.cache.setFetching(key);
    const abort = new AbortController();
    const p = (async () => {
      try {
        const res = await this.withRetry(() =>
          conn.sdk.readResource({ uri }, { signal: abort.signal, ...(opts.requestOptions ?? {}) }),
        );
        const extra = typeof opts.providesTags === "function" ? opts.providesTags(res) : opts.providesTags ?? [];
        this.cache.write(key, res, {
          staleTime: opts.staleTime,
          // every resource auto-provides its URI tag (+ server tag for blunt invalidation)
          tags: [resourceTag(server, uri), serverTag(server), ...extra],
        });
        if (opts.subscribe) await this.maybeProtocolSubscribe(key, true);
        return res;
      } catch (err) {
        this.cache.setError(key, this.toError(err, server, "protocol"));
        throw err;
      } finally {
        this.cache.setInflight(key, undefined);
      }
    })();
    this.cache.setInflight(key, p, abort);
    return p;
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
        { signal: opts.signal, onprogress: opts.onProgress, ...(opts.requestOptions ?? {}) },
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

  // ── raw message log (devtools) ───────────────────────────────────────────
  private msgStart = new Map<string | number, number>();
  private onTraffic(server: string, ev: TrafficEvent): void {
    const m = ev.message;
    if (m.method != null && m.id != null) {
      this.msgStart.set(m.id, Date.now());
      this.devtools?.emit({ type: "request", server, method: m.method, id: String(m.id), params: m.params, dir: ev.dir });
    } else if (m.method != null) {
      this.devtools?.emit({ type: "notification", server, method: m.method, params: m.params, dir: ev.dir });
    } else if (m.id != null) {
      const start = this.msgStart.get(m.id);
      this.msgStart.delete(m.id);
      this.devtools?.emit({ type: "response", server, id: String(m.id), ok: m.error == null, ms: start ? Date.now() - start : 0, dir: ev.dir });
    }
  }

  /** Set a server's logging verbosity (logging/setLevel). */
  setLogLevel(server: string, level: string): Promise<void> {
    return this.req(server).setLogLevel(level);
  }

  /** Liveness check — round-trips a ping to detect a silently-dead server. */
  ping(server: string): Promise<unknown> {
    return this.req(server).sdk.ping();
  }

  /** Argument autocompletion for a prompt or resource template (completion/complete). */
  async complete(
    ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string },
    argument: { name: string; value: string },
    server: string,
  ): Promise<string[]> {
    const res = (await this.req(server).sdk.complete({ ref, argument })) as {
      completion?: { values?: string[] };
    };
    return res.completion?.values ?? [];
  }

  /** Notify every connected server that the client's roots changed (roots/list_changed). */
  async notifyRootsChanged(): Promise<void> {
    await Promise.allSettled(this.connections().map((c) => c.sdk.sendRootsListChanged()));
  }

  // ── dynamic topology ──────────────────────────────────────────────────────
  /** Add and connect a server at runtime. */
  async addServer(name: string, conf: ConnectionConfig): Promise<void> {
    if (this.conns.has(name)) throw new Error(`server "${name}" already exists`);
    const handlers = this.interactions ? this.interactions.handlersFor(name, this.handlers) : this.handlers;
    const conn = new ServerConnection(name, conf, {
      cache: this.cache,
      handlers,
      onStateChange: (s, state, caps) => {
        this.bumpServerState();
        this.devtools?.emit({ type: "server-state", server: s, state, capabilities: caps });
      },
      onCapabilitiesChanged: (s, kind) => this.devtools?.emit({ type: "capabilities", server: s, kind }),
      onLog: (s, entry) => this.devtools?.emit({ type: "log", server: s, level: entry.level, data: entry.data }),
      onMessage: this.devtools ? (s, ev) => this.onTraffic(s, ev) : undefined,
    });
    this.conns.set(name, conn);
    await conn.connect();
  }

  /** Disconnect and remove a server at runtime. */
  async removeServer(name: string): Promise<void> {
    const conn = this.conns.get(name);
    if (!conn) return;
    await conn.close();
    this.conns.delete(name);
    this.cache.markStaleByServer(name);
    this.bumpServerState();
  }

  // ── readOnly tool as a cached query (useToolResult) ──────────────────────
  async queryTool<A extends Record<string, unknown>, R = unknown>(
    name: string,
    args: A,
    opts: QueryToolOpts = {},
  ): Promise<R> {
    const { server, def } = this.router.resolveTool(name, opts.server);
    const conn = this.req(server);
    const key = { kind: "toolResult", server, tool: def.name, argsHash: argsHash(args) } as const;

    const existing = this.cache.inflight(key);
    if (existing) return existing as Promise<R>;

    this.cache.setFetching(key);
    const abort = new AbortController();
    const p = (async () => {
      try {
        const result = (await this.withRetry(() =>
          conn.sdk.callTool({ name: def.name, arguments: args }, undefined, {
            signal: abort.signal,
            ...(opts.requestOptions ?? {}),
          }),
        )) as R;
        const extra = typeof opts.providesTags === "function" ? opts.providesTags(result) : opts.providesTags ?? [];
        this.cache.write(key, result, { tags: [serverTag(server), ...extra] });
        return result;
      } catch (err) {
        this.cache.setError(key, this.toError(err, server, "protocol"));
        throw err;
      } finally {
        this.cache.setInflight(key, undefined);
      }
    })();
    this.cache.setInflight(key, p, abort);
    return p;
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

  /** Retry a read up to `retry` times (no backoff state needed — reads are idempotent). */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retryCount; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private toError(err: unknown, server: string, kind: MCPError["kind"]): MCPError {
    const e = err as { message?: string; code?: number; data?: unknown };
    return { kind, server, message: e?.message ?? String(err), code: e?.code, data: e?.data };
  }
}
