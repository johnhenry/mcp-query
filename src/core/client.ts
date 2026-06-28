// MCPClient — the public, framework-agnostic entry point. Owns the cache, the set
// of server connections (multiplexing), the router, and the host handlers. Exposes
// the imperative read/call/list API that the React hooks sit on top of.

import { MCPCache, type CachePatch } from "./cache.js";
import type { CacheStore } from "./cacheStore.js";
import { ServerConnection, type ConnectionConfig } from "./connection.js";
import { InteractionBroker } from "./interactions.js";
import type { TrafficEvent } from "./instrument.js";
import { runInterceptors, type Operation, type RequestInterceptor } from "./interceptors.js";
import { Router } from "./router.js";
import { argsHash, serializeKey, type CacheKey } from "./keys.js";
import { capsTag, resourceTag, serverTag, type Tag } from "./tags.js";
import type { DevtoolsSink } from "../devtools/protocol.js";
import type { ClientInfo, HostHandlers, MCPError, ServerState, Tool } from "./types.js";

export interface MCPClientConfig {
  servers: Record<string, ConnectionConfig>;
  handlers?: HostHandlers;
  /** Human-in-the-loop broker; routes sampling + elicitation through one approval queue. */
  interactions?: InteractionBroker;
  /** scheme -> server for resource routing, e.g. { file: "fs", github: "github" }. */
  schemeMap?: Record<string, string>;
  cache?: MCPCache;
  /** Optional async L2 store (cross-instance cache sharing + distributed invalidation). */
  cacheStore?: CacheStore;
  devtools?: DevtoolsSink;
  /** Request interceptors (auth, tracing, rate-limit, …) wrapping every read/call/query. */
  interceptors?: RequestInterceptor[];
  /** Retry count for *reads* (resource reads + tool queries are safe to retry). Default 0. */
  retry?: number;
  /** Identity advertised to every server during initialize. Defaults to mcp-query's own. */
  clientInfo?: ClientInfo;
  /** Client-wide default request timeouts, overridden per-call by `requestOptions`. */
  defaultRequestOptions?: RequestTimeoutOpts;
  /** Durable audit sink — called for every read/call/query with its outcome + timing. */
  onCall?: (entry: CallAuditEntry) => void;
}

/** One audited operation (every read/call/query) for a durable governance log. */
export interface CallAuditEntry {
  at: number;
  ms: number;
  server: string;
  kind: "read" | "call" | "query";
  target: string;
  /** `context.meta.principal`, if the caller set one. */
  principal?: unknown;
  outcome: "ok" | "denied" | "error";
  error?: string;
}

/** Per-request timeout knobs (mirrors the SDK's RequestOptions), exposed like Inspector. */
export interface RequestTimeoutOpts {
  timeout?: number;
  resetTimeoutOnProgress?: boolean;
  maxTotalTimeout?: number;
}

/**
 * Per-call context for server-side / multi-tenant use: isolate cache entries by
 * `partition` (e.g. a tenant or session id) and pass `meta` (a principal/user id, …) to
 * the server via the request's `_meta`. See `client.scope(context)` for an ergonomic
 * per-request wrapper. NOTE: true per-user *auth* on a shared connection isn't an MCP
 * concept — for that, instantiate one MCPClient per principal; `context` gives cache
 * isolation + `_meta` propagation on a shared client.
 */
export interface CallContext {
  partition?: string;
  meta?: Record<string, unknown>;
}

export interface ReadResourceOpts {
  server?: string;
  subscribe?: boolean;
  staleTime?: number;
  /** Extra tags this entry provides — a list, or a function of the result (entity layer). */
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  requestOptions?: RequestTimeoutOpts;
  context?: CallContext;
}

export interface QueryToolOpts {
  server?: string;
  /** Extra tags this cached result provides — list or function of result (entity layer). */
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  requestOptions?: RequestTimeoutOpts;
  context?: CallContext;
}

export interface CallToolOpts<A, R> {
  server?: string;
  invalidates?: Tag[] | ((args: A, result: R) => Tag[]);
  optimistic?: (args: A) => CachePatch[];
  signal?: AbortSignal;
  onProgress?: (p: { progress: number; total?: number }) => void;
  requestOptions?: RequestTimeoutOpts;
  context?: CallContext;
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
  private capListeners = new Set<(server: string, kind: "tools" | "resources" | "prompts") => void>();
  private stateVersion = 0;
  private retryCount = 0;
  private clientInfo?: ClientInfo;
  private defaultRequestOptions?: RequestTimeoutOpts;
  private interceptors: RequestInterceptor[];
  private onCall?: (entry: CallAuditEntry) => void;
  private draining = false;
  private inFlight = new Set<Promise<unknown>>();
  private cacheStore?: CacheStore;

  constructor(cfg: MCPClientConfig) {
    this.handlers = cfg.handlers ?? {};
    this.devtools = cfg.devtools;
    this.interactions = cfg.interactions;
    this.interceptors = cfg.interceptors ?? [];
    this.onCall = cfg.onCall;
    this.cacheStore = cfg.cacheStore;
    this.retryCount = cfg.retry ?? 0;
    this.clientInfo = cfg.clientInfo;
    this.defaultRequestOptions = cfg.defaultRequestOptions;
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
          // Distributed invalidation: declared invalidations fan out to other nodes via L2.
          onInvalidateTags: (tags) => void this.cacheStore?.publishInvalidation?.(tags),
        },
      });

    // Apply other nodes' invalidations to this L1 (without re-broadcasting → no loop).
    this.cacheStore?.subscribeInvalidations?.((tags) => this.cache.invalidateTags(tags, false));

    for (const [name, conf] of Object.entries(cfg.servers)) {
      this.conns.set(name, this.newConnection(name, conf));
    }
    this.router = new Router(this.conns, cfg.schemeMap);
  }

  /** Build a ServerConnection with the shared deps (broker routing, devtools taps, identity). */
  private newConnection(name: string, conf: ConnectionConfig): ServerConnection {
    // When a broker is present, sampling + elicitation are routed through it with
    // server context; other handlers (roots) pass through.
    const handlers = this.interactions ? this.interactions.handlersFor(name, this.handlers) : this.handlers;
    return new ServerConnection(name, conf, {
      cache: this.cache,
      handlers,
      clientInfo: this.clientInfo,
      onStateChange: (s, state, caps) => {
        this.bumpServerState();
        this.devtools?.emit({ type: "server-state", server: s, state, capabilities: caps });
      },
      onCapabilitiesChanged: (s, kind) => {
        for (const cb of this.capListeners) cb(s, kind);
        this.devtools?.emit({ type: "capabilities", server: s, kind });
      },
      onLog: (s, entry) => this.devtools?.emit({ type: "log", server: s, level: entry.level, data: entry.data }),
      onMessage: this.devtools ? (s, ev) => this.onTraffic(s, ev) : undefined,
    });
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

  /** Subscribe to upstream capability changes (list_changed re-lists). Returns unsubscribe. */
  subscribeCapabilities(cb: (server: string, kind: "tools" | "resources" | "prompts") => void): () => void {
    this.capListeners.add(cb);
    return () => this.capListeners.delete(cb);
  }

  /**
   * A per-request view bound to a `CallContext` (partition + meta). Lets one shared
   * client serve many principals: `const s = client.scope({ partition: tenantId, meta:
   * { userId } }); await s.readResource(uri)`. Per-call opts override the bound context.
   */
  scope(context: CallContext) {
    const merge = <O extends { context?: CallContext }>(opts: O): O => ({
      ...opts,
      context: { ...context, ...opts.context },
    });
    return {
      readResource: (uri: string, opts: ReadResourceOpts = {}) => this.readResource(uri, merge(opts)),
      callTool: <A extends Record<string, unknown>, R = unknown>(name: string, args: A, opts: CallToolOpts<A, R> = {}) =>
        this.callTool<A, R>(name, args, merge(opts)),
      queryTool: <A extends Record<string, unknown>, R = unknown>(name: string, args: A, opts: QueryToolOpts = {}) =>
        this.queryTool<A, R>(name, args, merge(opts)),
    };
  }

  /** Run an operation through the interceptor chain (audited + tracked for drain). */
  private run(op: Operation, exec: (op: Operation) => Promise<unknown>): Promise<unknown> {
    if (this.draining) return Promise.reject(new Error("client is draining"));
    const at = this.onCall ? Date.now() : 0;
    let base = this.interceptors.length ? runInterceptors(this.interceptors, op, exec) : exec(op);
    if (this.onCall) {
      base = base.then(
        (r) => (this.audit(op, at, "ok"), r),
        (e) => {
          // -32003 is AuthorizationError's code (mcp-query/server); don't import across layers.
          this.audit(op, at, (e as { code?: number })?.code === -32003 ? "denied" : "error", e instanceof Error ? e.message : String(e));
          throw e;
        },
      );
    }
    this.inFlight.add(base);
    const rm = () => this.inFlight.delete(base);
    base.then(rm, rm);
    return base;
  }

  private audit(op: Operation, at: number, outcome: CallAuditEntry["outcome"], error?: string): void {
    this.onCall?.({ at, ms: Date.now() - at, server: op.server, kind: op.kind, target: op.target, principal: (op.context?.meta as { principal?: unknown } | undefined)?.principal, outcome, error });
  }

  /** L2 read-through: if L1 has no fresh data, populate it from the store. Returns the hit. */
  private async l2ReadThrough(key: CacheKey): Promise<{ data: unknown } | undefined> {
    if (!this.cacheStore || this.cache.getSnapshot(key)?.status === "success") return undefined;
    const stored = await this.cacheStore.get(serializeKey(key));
    if (!stored) return undefined;
    this.cache.write(key, stored.data, { tags: stored.tags });
    return { data: stored.data };
  }
  private l2WriteThrough(key: CacheKey, data: unknown, tags: string[]): void {
    void this.cacheStore?.set(serializeKey(key), { data, tags, updatedAt: Date.now() });
  }

  /** Graceful shutdown: refuse new ops, await in-flight, then close all connections (SIGTERM). */
  async drain(): Promise<void> {
    this.draining = true;
    await Promise.allSettled([...this.inFlight]);
    await this.close();
  }

  /** Per-server health snapshot for readiness probes (+ does a live ping per server). */
  async health(): Promise<Record<string, { state: ServerState; pingMs?: number; ok: boolean }>> {
    const out: Record<string, { state: ServerState; pingMs?: number; ok: boolean }> = {};
    await Promise.all(
      this.connections().map(async (c) => {
        const start = Date.now();
        let ok = false;
        let pingMs: number | undefined;
        try {
          await c.sdk.ping();
          ok = true;
          pingMs = Date.now() - start;
        } catch {
          ok = false;
        }
        out[c.name] = { state: c.state, pingMs, ok };
      }),
    );
    return out;
  }

  // ── reads (useResource) ────────────────────────────────────────────────
  async readResource(uri: string, opts: ReadResourceOpts = {}): Promise<unknown> {
    const { server } = this.router.resolveResource(uri, opts.server);
    const op: Operation = { kind: "read", server, target: uri, context: opts.context, state: {} };
    return this.run(op, (o) => this.execRead(o.server, o.target, { ...opts, context: o.context }));
  }

  private execRead(server: string, uri: string, opts: ReadResourceOpts): Promise<unknown> {
    const conn = this.req(server);
    const key = { kind: "resource", server, uri, partition: opts.context?.partition } as const;
    const meta = opts.context?.meta;

    // De-dupe: concurrent reads of the same key share one in-flight request.
    const existing = this.cache.inflight(key);
    if (existing) return existing;

    this.cache.setFetching(key);
    const abort = new AbortController();
    const p = (async () => {
      try {
        // L2 read-through: another node may have cached this; skip the network on a hit.
        const fromL2 = await this.l2ReadThrough(key);
        if (fromL2) {
          if (opts.subscribe) await this.maybeProtocolSubscribe(key, true);
          return fromL2.data;
        }
        const res = await this.withRetry(() =>
          conn.sdk.readResource(
            { uri, ...(meta ? { _meta: meta } : {}) },
            { signal: abort.signal, ...this.defaultRequestOptions, ...(opts.requestOptions ?? {}) },
          ),
        );
        const extra = typeof opts.providesTags === "function" ? opts.providesTags(res) : opts.providesTags ?? [];
        const tags = [resourceTag(server, uri), serverTag(server), ...extra];
        this.cache.write(key, res, { staleTime: opts.staleTime, tags });
        this.l2WriteThrough(key, res, tags);
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
    const op: Operation = { kind: "call", server, target: def.name, def, args, context: opts.context, state: {} };
    return this.run(op, (o) => this.execCall<A, R>(server, def, o.args as A, { ...opts, context: o.context })) as Promise<R>;
  }

  private async execCall<A extends Record<string, unknown>, R = unknown>(
    server: string,
    def: Tool,
    args: A,
    opts: CallToolOpts<A, R>,
  ): Promise<R> {
    const conn = this.req(server);
    const readOnly = def.annotations?.readOnlyHint === true;

    const meta = opts.context?.meta;
    const rollback = opts.optimistic ? this.cache.patch(opts.optimistic(args)) : undefined;
    try {
      const result = (await conn.sdk.callTool(
        { name: def.name, arguments: args, ...(meta ? { _meta: meta } : {}) },
        undefined,
        { signal: opts.signal, onprogress: opts.onProgress, ...this.defaultRequestOptions, ...(opts.requestOptions ?? {}) },
      )) as unknown as R & { isError?: boolean };

      // Tool-level error channel: surfaced as data, NOT thrown (mirrors GraphQL errors[]).
      if (result.isError) rollback?.();

      // readOnly tool results may be cached by (name,args) like a query.
      if (readOnly) {
        this.cache.write(
          { kind: "toolResult", server, tool: def.name, argsHash: argsHash(args), partition: opts.context?.partition },
          result,
          { tags: [serverTag(server)] },
        );
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
    const conn = this.newConnection(name, conf);
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
    const op: Operation = { kind: "query", server, target: def.name, def, args, context: opts.context, state: {} };
    return this.run(op, (o) => this.execQuery<R>(server, def, o.args as A, { ...opts, context: o.context })) as Promise<R>;
  }

  private execQuery<R = unknown>(server: string, def: Tool, args: Record<string, unknown>, opts: QueryToolOpts): Promise<R> {
    const conn = this.req(server);
    const key = { kind: "toolResult", server, tool: def.name, argsHash: argsHash(args), partition: opts.context?.partition } as const;
    const meta = opts.context?.meta;

    const existing = this.cache.inflight(key);
    if (existing) return existing as Promise<R>;

    this.cache.setFetching(key);
    const abort = new AbortController();
    const p = (async () => {
      try {
        const fromL2 = await this.l2ReadThrough(key);
        if (fromL2) return fromL2.data as R;
        const result = (await this.withRetry(() =>
          conn.sdk.callTool({ name: def.name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, {
            signal: abort.signal,
            ...this.defaultRequestOptions, ...(opts.requestOptions ?? {}),
          }),
        )) as R;
        const extra = typeof opts.providesTags === "function" ? opts.providesTags(result) : opts.providesTags ?? [];
        const tags = [serverTag(server), ...extra];
        this.cache.write(key, result, { tags });
        this.l2WriteThrough(key, result, tags);
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
    // Prompts have their own registry — route by which server offers the prompt, not by tool.
    const s = server ?? this.connections().find((c) => c.prompts.has(name))?.name;
    if (!s) throw new Error(`No connected server offers prompt "${name}"`);
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
