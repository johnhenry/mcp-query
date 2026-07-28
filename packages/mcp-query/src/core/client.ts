// MCPClient — the public, framework-agnostic entry point. Owns the cache, the set
// of server connections (multiplexing), the router, and the host handlers. Exposes
// the imperative read/call/list API that the React hooks sit on top of.

import {
  ProtocolError,
  ResourceNotFoundError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  LOG_LEVEL_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  type InputRequiredOptions,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";

import { MCPCache, type CachePatch } from "./cache.js";
import type { CacheStore } from "./cacheStore.js";
import { cacheScope, cacheTtl, ServerConnection, type ConnectionConfig } from "./connection.js";
import { InteractionBroker } from "./interactions.js";
import type { TrafficEvent } from "./instrument.js";
import { runInterceptors, type Operation, type RequestInterceptor } from "./interceptors.js";
import { Router } from "./router.js";
import { argsHash, serializeKey, type CacheKey } from "./keys.js";
import { capsTag, resourceTag, serverTag, type Tag } from "./tags.js";
import type { DevtoolsSink } from "../devtools/protocol.js";
import {
  CallToolOrTaskResultSchema,
  CancelTaskResultSchema,
  GetTaskResultSchema,
  isTaskShaped,
  TASKS_EXT,
  TERMINAL_STATUSES,
  UpdateTaskResultSchema,
  type DetailedTask,
  type Task,
} from "./tasksExt.js";
import {
  MCPError,
  type ClientInfo,
  type ElicitationRequest,
  type HostHandlers,
  type LoggingLevel,
  type ServerState,
  type Tool,
} from "./types.js";

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
  /** Identity advertised to every server. Defaults to mcp-query's own. */
  clientInfo?: ClientInfo;
  /**
   * Client-wide protocol-revision preference list, overridable per connection.
   * Absent → v1 only (the classic 2025-era handshake, no probe — the default).
   * `["2026-07-28", "2025-11-25"]` opts into the modern revision with lossless
   * v1 fallback; a modern-only list pins (no fallback). See
   * `ConnectionConfig.versions`.
   */
  versions?: readonly string[];
  /**
   * Low-level client-wide negotiation escape hatch (the SDK's option shape);
   * takes precedence over `versions` when both are set.
   */
  versionNegotiation?: VersionNegotiationOptions;
  /** Client-wide multi-round-trip auto-fulfilment knobs (maxRounds etc.). */
  inputRequired?: InputRequiredOptions;
  /**
   * Modern-era log delivery: servers only emit `notifications/message` for
   * requests carrying the `io.modelcontextprotocol/logLevel` `_meta` key. Set
   * this to attach it to every request (per-call `CallContext.logLevel` wins).
   * Legacy-era log delivery still uses `setLogLevel`.
   */
  defaultLogLevel?: LoggingLevel;
  /** Fallback poll cadence (ms) for task handles when the server sends no pollIntervalMs. Default 150. */
  taskPollMs?: number;
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
  /**
   * Modern-era per-request log delivery (2026-07-28): attaches the
   * `io.modelcontextprotocol/logLevel` `_meta` key so the server emits
   * `notifications/message` for this request at the given severity.
   */
  logLevel?: LoggingLevel;
}

export interface ReadResourceOpts {
  server?: string;
  subscribe?: boolean;
  staleTime?: number;
  /** ms an unobserved entry lingers before eviction (per-entry gc). Default 5 min. */
  gcTime?: number;
  /** Extra tags this entry provides — a list, or a function of the result (entity layer). */
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  requestOptions?: RequestTimeoutOpts;
  context?: CallContext;
}

export interface QueryToolOpts {
  server?: string;
  /** ms an unobserved entry lingers before eviction (per-entry gc). Default 5 min. */
  gcTime?: number;
  /** Extra tags this cached result provides — list or function of result (entity layer). */
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  requestOptions?: RequestTimeoutOpts;
  context?: CallContext;
}

/** Options for task-augmented tool calls (callToolTask). */
export interface TaskCallOpts {
  server?: string;
  /**
   * @deprecated Ignored — under the tasks extension (SEP-2663, 2026-07-28)
   * task creation is server-directed; there are no client task params.
   */
  task?: Record<string, unknown>;
  signal?: AbortSignal;
  requestOptions?: RequestTimeoutOpts;
  context?: CallContext;
}

/**
 * A live handle on a task-augmented tool call. Status snapshots are cache-backed —
 * `subscribe` fires on both the handle's own `tasks/get` polling and server
 * `notifications/tasks` pushes, and `useTask` observes the same entries.
 */
export interface TaskHandle<R = unknown> {
  taskId: string;
  server: string;
  /** Latest known status snapshot (undefined only before the first write lands). */
  task(): Task | undefined;
  /** Observe live status updates. Returns unsubscribe. */
  subscribe(fn: (task: Task) => void): () => void;
  /** Resolves with the tool result when the task completes; rejects on failure/cancel. */
  result(): Promise<R>;
  /** Ask the server to cancel this task (tasks/cancel). */
  cancel(): Promise<void>;
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
  /** Per-server handler views (broker-routed when a broker is configured). */
  private serverHandlers = new Map<string, HostHandlers>();
  private devtools?: DevtoolsSink;
  private stateListeners = new Set<() => void>();
  private capListeners = new Set<(server: string, kind: "tools" | "resources" | "prompts") => void>();
  private stateVersion = 0;
  private retryCount = 0;
  private clientInfo?: ClientInfo;
  private versions?: readonly string[];
  private versionNegotiation?: VersionNegotiationOptions;
  private inputRequired?: InputRequiredOptions;
  private defaultLogLevel?: LoggingLevel;
  private taskPollMs: number;
  private defaultRequestOptions?: RequestTimeoutOpts;
  private interceptors: RequestInterceptor[];
  private onCall?: (entry: CallAuditEntry) => void;
  private draining = false;
  private inFlight = new Set<Promise<unknown>>();
  private cacheStore?: CacheStore;
  private schemeMap?: Record<string, string>;
  private syncTaskSeq = 0;

  constructor(cfg: MCPClientConfig) {
    this.handlers = cfg.handlers ?? {};
    this.devtools = cfg.devtools;
    this.interactions = cfg.interactions;
    this.interceptors = cfg.interceptors ?? [];
    this.onCall = cfg.onCall;
    this.cacheStore = cfg.cacheStore;
    this.retryCount = cfg.retry ?? 0;
    this.clientInfo = cfg.clientInfo;
    this.versions = cfg.versions;
    this.versionNegotiation = cfg.versionNegotiation;
    this.inputRequired = cfg.inputRequired;
    this.defaultLogLevel = cfg.defaultLogLevel;
    this.taskPollMs = cfg.taskPollMs ?? 150;
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

    this.schemeMap = cfg.schemeMap;
    for (const [name, conf] of Object.entries(cfg.servers)) {
      this.conns.set(name, this.newConnection(name, conf));
    }
    this.router = new Router(this.conns, cfg.schemeMap);
  }

  /** Build a ServerConnection with the shared deps (broker routing, devtools taps, identity). */
  private newConnection(name: string, conf: ConnectionConfig): ServerConnection {
    // When a broker is present, sampling + elicitation are routed through it with
    // server context; other handlers (roots) pass through. On modern connections
    // the SDK's multi-round-trip driver reuses the SAME handlers, so the broker
    // gates in-band input_required rounds too.
    const handlers = this.interactions ? this.interactions.handlersFor(name, this.handlers) : this.handlers;
    this.serverHandlers.set(name, handlers);
    return new ServerConnection(name, conf, {
      cache: this.cache,
      handlers,
      clientInfo: this.clientInfo,
      defaultVersionNegotiation: this.versionNegotiation,
      defaultVersions: this.versions,
      defaultInputRequired: this.inputRequired,
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

  /** Connect all eager servers. Lazy ones connect on first use. Failures are isolated. */
  async connect(): Promise<void> {
    await Promise.allSettled([...this.conns.values()].filter((c) => !c.isLazy).map((c) => c.connect()));
  }

  /** Wake a (possibly lazy) server before routing — no-op for eager/already-connected. */
  private async wake(server: string | undefined): Promise<void> {
    if (server) await this.conns.get(server)?.ensureReady();
  }

  /** Best-effort server hint from an explicit opt, a `server.tool` prefix, or a URI scheme. */
  private hint(target: string, explicit?: string): string | undefined {
    if (explicit) return explicit;
    const dot = target.indexOf(".");
    if (dot > 0 && this.conns.has(target.slice(0, dot))) return target.slice(0, dot);
    const scheme = target.includes("://") ? target.slice(0, target.indexOf(":")) : undefined;
    return scheme ? this.schemeMap?.[scheme] : undefined;
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
          // (Safe vs the 2026-07-28 reserved band, which starts at -32020.)
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

  /**
   * Build the request `_meta` from a CallContext: caller meta plus, on modern-era
   * connections, the per-request logLevel envelope key (absent key = the server
   * emits no notifications/message for the request, per the 2026-07-28 spec).
   */
  private withMeta(conn: ServerConnection, context?: CallContext): Record<string, unknown> | undefined {
    const level = context?.logLevel ?? this.defaultLogLevel;
    const wantLevel = conn.era === "modern" && level != null;
    if (!context?.meta && !wantLevel) return undefined;
    return { ...(context?.meta ?? {}), ...(wantLevel ? { [LOG_LEVEL_META_KEY]: level } : {}) };
  }

  /** L2 read-through: if L1 has no fresh data, populate it from the store. Returns the hit. */
  private async l2ReadThrough(key: CacheKey): Promise<{ data: unknown } | undefined> {
    if (!this.cacheStore || this.cache.getSnapshot(key)?.status === "success") return undefined;
    const stored = await this.cacheStore.get(serializeKey(key));
    if (!stored) return undefined;
    this.cache.write(key, stored.data, { tags: stored.tags, scope: stored.scope });
    return { data: stored.data };
  }
  private l2WriteThrough(key: CacheKey, data: unknown, tags: string[], scope?: "public" | "private"): void {
    // SEP-2549: never share a private-scoped entry across authorization contexts.
    // A partitioned key is already isolated per context, so it may go to L2.
    if (scope === "private" && !key.partition) return;
    void this.cacheStore?.set(serializeKey(key), { data, tags, updatedAt: Date.now(), scope });
  }

  /** Graceful shutdown: refuse new ops, await in-flight, then close all connections (SIGTERM). */
  async drain(): Promise<void> {
    this.draining = true;
    await Promise.allSettled([...this.inFlight]);
    await this.close();
  }

  /**
   * Per-server health snapshot for readiness probes. Round-trips `ping` on
   * legacy connections and `server/discover` on modern ones (the 2026-07-28
   * revision removed `ping`).
   */
  async health(): Promise<Record<string, { state: ServerState; pingMs?: number; ok: boolean }>> {
    const out: Record<string, { state: ServerState; pingMs?: number; ok: boolean }> = {};
    await Promise.all(
      this.connections().map(async (c) => {
        const start = Date.now();
        let ok = false;
        let pingMs: number | undefined;
        try {
          if (c.era === "modern") await c.sdk.discover();
          else await c.sdk.ping();
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
    await this.wake(this.hint(uri, opts.server));
    const { server } = this.router.resolveResource(uri, opts.server);
    const op: Operation = { kind: "read", server, target: uri, context: opts.context, state: {} };
    return this.run(op, (o) => this.execRead(o.server, o.target, { ...opts, context: o.context }));
  }

  private execRead(server: string, uri: string, opts: ReadResourceOpts): Promise<unknown> {
    const conn = this.req(server);
    const key = { kind: "resource", server, uri, partition: opts.context?.partition } as const;

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
        const meta = this.withMeta(conn, opts.context);
        const res = await this.withRetry(() =>
          conn.sdk.readResource(
            { uri, ...(meta ? { _meta: meta } : {}) },
            // mcp-query's MCPCache is the caching layer — bypass the SDK's own
            // response cache to avoid double-storing an unbounded URI keyspace.
            { signal: abort.signal, cacheMode: "bypass", ...this.defaultRequestOptions, ...(opts.requestOptions ?? {}) },
          ),
        );
        const extra = typeof opts.providesTags === "function" ? opts.providesTags(res) : opts.providesTags ?? [];
        const tags = [resourceTag(server, uri), serverTag(server), ...extra];
        // SEP-2549: explicit caller staleTime wins; else the server's ttlMs (0 = stale now).
        const scope = cacheScope(res);
        this.cache.write(key, res, { staleTime: opts.staleTime ?? cacheTtl(res), gcTime: opts.gcTime, tags, scope });
        this.l2WriteThrough(key, res, tags, scope);
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
    await this.wake(this.hint(name, opts.server));
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

    const meta = this.withMeta(conn, opts.context);
    const rollback = opts.optimistic ? this.cache.patch(opts.optimistic(args)) : undefined;
    try {
      const result = (await conn.sdk.callTool(
        { name: def.name, arguments: args, ...(meta ? { _meta: meta } : {}) },
        {
          signal: opts.signal,
          onprogress: opts.onProgress,
          // We already hold the routed Tool — hand it to the SDK so output-schema
          // validation and SEP-2243 header mirroring never depend on its own cache.
          toolDefinition: def,
          ...this.defaultRequestOptions,
          ...(opts.requestOptions ?? {}),
        },
      )) as unknown as R & { isError?: boolean };

      // Tool-level error channel: surfaced as data, NOT thrown (mirrors GraphQL errors[]).
      if (result.isError) rollback?.();

      // readOnly tool results may be cached by (name,args) like a query.
      if (readOnly) {
        this.cache.write(
          { kind: "toolResult", server, tool: def.name, argsHash: argsHash(args), partition: opts.context?.partition },
          result,
          { tags: [serverTag(server)], staleTime: cacheTtl(result), scope: cacheScope(result) },
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

  /**
   * Set a server's logging verbosity (logging/setLevel).
   *
   * @deprecated Logging is deprecated as of 2026-07-28 (SEP-2577); the RPC does
   * not exist on modern connections (no-op there). Use `CallContext.logLevel` /
   * `defaultLogLevel` for modern-era per-request log delivery.
   */
  setLogLevel(server: string, level: string): Promise<void> {
    return this.req(server).setLogLevel(level);
  }

  /**
   * Liveness check — round-trips `ping` (legacy) or `server/discover` (modern;
   * the 2026-07-28 revision removed `ping`).
   *
   * @deprecated Prefer `health()`, which is era-aware and reports per-server state.
   */
  ping(server: string): Promise<unknown> {
    const conn = this.req(server);
    return conn.era === "modern" ? conn.sdk.discover() : conn.sdk.ping();
  }

  /**
   * Argument autocompletion for a prompt or resource template (completion/complete).
   * Pass `opts.context.arguments` (the values already filled in) so servers can narrow
   * dependent completions — e.g. the second argument's candidates depend on the first.
   */
  async complete(
    ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string },
    argument: { name: string; value: string },
    server: string,
    opts: { context?: { arguments?: Record<string, string> } } = {},
  ): Promise<string[]> {
    await this.wake(server);
    const res = (await this.req(server).sdk.complete({ ref, argument, context: opts.context })) as {
      completion?: { values?: string[] };
    };
    return res.completion?.values ?? [];
  }

  // ── tasks (io.modelcontextprotocol/tasks extension, SEP-2663) ─────────────
  //
  // Implemented over raw request() with mcp-query-defined schemas: the v2 SDK
  // ships no tasks runtime and era-gates the tasks RPCs off the 2026-07-28
  // wire, so the extension is currently drivable on LEGACY-era connections
  // only. One choke point (assertTasksCallable) holds the gate — see
  // https://github.com/johnhenry/mcp-query/issues/12

  private assertTasksCallable(conn: ServerConnection): void {
    if (conn.era === "modern") {
      throw new MCPError(
        "protocol",
        `tasks are not yet callable on a 2026-07-28 connection: @modelcontextprotocol/client has no ${TASKS_EXT} runtime ` +
          `(tracking: https://github.com/johnhenry/mcp-query/issues/12). ` +
          `Pin this server's versionNegotiation to { mode: "legacy" } to use tasks today.`,
        conn.name,
      );
    }
    if (!conn.supports("tasks")) {
      throw new MCPError(
        "protocol",
        `server "${conn.name}" does not advertise the tasks extension (capabilities.extensions["${TASKS_EXT}"])`,
        conn.name,
      );
    }
  }

  /** The extension declaration servers read off each request's _meta (per SEP-2663). */
  private tasksMeta(meta?: Record<string, unknown>): Record<string, unknown> {
    return { ...(meta ?? {}), [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXT]: {} } } };
  }

  private taskKey(server: string, taskId: string, context?: CallContext): CacheKey {
    return { kind: "task", server, taskId, partition: context?.partition };
  }

  /** Write a task snapshot: terminal snapshots stay fresh for the retention ttlMs, live ones for a poll beat. */
  private writeTaskSnapshot(server: string, task: Task | DetailedTask, context?: CallContext): void {
    const terminal = TERMINAL_STATUSES.includes(task.status);
    this.cache.write(this.taskKey(server, task.taskId, context), task, {
      tags: [serverTag(server)],
      staleTime: terminal ? (task.ttlMs ?? undefined) : (task.pollIntervalMs ?? this.taskPollMs),
    });
  }

  /**
   * Start a task-augmented tool call (call-now, fetch-later). Under SEP-2663 the
   * server decides whether to answer `tools/call` with a task handle or a plain
   * (synchronous) result — the returned TaskHandle covers both: a real task is
   * polled via `tasks/get` (honoring the server's pollIntervalMs), with
   * `input_required` rounds routed through the host handlers/broker and answered
   * via `tasks/update`; a synchronous result yields an already-completed handle.
   * The interceptor chain and audit wrap task INITIATION (authorize/rate-limit
   * apply when the task starts, not per status poll).
   */
  async callToolTask<A extends Record<string, unknown>, R = unknown>(
    name: string,
    args: A,
    opts: TaskCallOpts = {},
  ): Promise<TaskHandle<R>> {
    await this.wake(this.hint(name, opts.server));
    const { server, def } = this.router.resolveTool(name, opts.server);
    const op: Operation = { kind: "call", server, target: def.name, def, args, context: opts.context, state: {} };
    return this.run(op, (o) =>
      this.execCallToolTask<R>(server, def, o.args as Record<string, unknown>, { ...opts, context: o.context }),
    ) as Promise<TaskHandle<R>>;
  }

  private async execCallToolTask<R>(
    server: string,
    def: Tool,
    args: Record<string, unknown>,
    opts: TaskCallOpts,
  ): Promise<TaskHandle<R>> {
    const conn = this.req(server);
    this.assertTasksCallable(conn);

    const res = await conn.sdk.request(
      {
        method: "tools/call",
        params: { name: def.name, arguments: args, _meta: this.tasksMeta(this.withMeta(conn, opts.context)) },
      },
      CallToolOrTaskResultSchema,
      { signal: opts.signal, ...this.defaultRequestOptions, ...(opts.requestOptions ?? {}) },
    );

    if (!isTaskShaped(res)) {
      // Server chose synchronous execution — spec says clients MUST handle either.
      const syntheticId = `sync-${++this.syncTaskSeq}`;
      const now = new Date().toISOString();
      const snapshot: Task = { taskId: syntheticId, status: "completed", createdAt: now, lastUpdatedAt: now, ttlMs: null };
      this.writeTaskSnapshot(server, snapshot, opts.context);
      return {
        taskId: syntheticId,
        server,
        task: () => this.cache.getSnapshot(this.taskKey(server, syntheticId, opts.context))?.data as Task | undefined,
        subscribe: () => () => {},
        result: () => Promise.resolve(res as R),
        cancel: () => Promise.resolve(),
      };
    }

    this.writeTaskSnapshot(server, res, opts.context);
    return this.makeTaskHandle<R>(conn, res, opts.context);
  }

  private makeTaskHandle<R>(conn: ServerConnection, seed: Task, context?: CallContext): TaskHandle<R> {
    const server = conn.name;
    const key = this.taskKey(server, seed.taskId, context);
    const answered = new Set<string>();
    let loop: Promise<void> | undefined;
    let settled = false;
    let resolveResult!: (r: R) => void;
    let rejectResult!: (e: unknown) => void;
    const result = new Promise<R>((res, rej) => ((resolveResult = res), (rejectResult = rej)));
    result.catch(() => {}); // handle callers may never ask for the result

    const settle = (task: DetailedTask): boolean => {
      if (settled) return true;
      if (task.status === "completed") {
        settled = true;
        resolveResult((task.result ?? {}) as R);
      } else if (task.status === "failed") {
        settled = true;
        const e = task.error as { message?: string; code?: number; data?: unknown } | undefined;
        rejectResult(new MCPError("protocol", e?.message ?? `task ${task.taskId} failed`, server, e?.code, e?.data));
      } else if (task.status === "cancelled") {
        settled = true;
        rejectResult(new MCPError("cancelled", `task ${task.taskId} was cancelled`, server));
      }
      return settled;
    };

    const answerInputs = async (task: DetailedTask): Promise<void> => {
      if (task.status !== "input_required" || !task.inputRequests) return;
      const handlers = this.serverHandlers.get(server) ?? this.handlers;
      const inputResponses: Record<string, unknown> = {};
      for (const [k, reqObj] of Object.entries(task.inputRequests)) {
        if (answered.has(k)) continue;
        try {
          if (reqObj.method === "elicitation/create" && handlers.elicitation) {
            inputResponses[k] = await handlers.elicitation(reqObj.params as ElicitationRequest);
          } else if (reqObj.method === "sampling/createMessage" && handlers.sampling) {
            inputResponses[k] = await handlers.sampling(reqObj.params);
          } else if (reqObj.method === "roots/list" && handlers.roots) {
            inputResponses[k] = { roots: handlers.roots() };
          } else if (reqObj.method === "elicitation/create") {
            inputResponses[k] = { action: "decline" }; // no handler ⇒ decline rather than hang
          } else {
            continue; // unanswerable (no sampling/roots handler) — leave pending
          }
          answered.add(k);
        } catch {
          // Handler rejection (e.g. broker deny) — decline elicitations, skip others.
          if (reqObj.method === "elicitation/create") {
            inputResponses[k] = { action: "decline" };
            answered.add(k);
          }
        }
      }
      if (Object.keys(inputResponses).length) {
        try {
          await conn.sdk.request(
            { method: "tasks/update", params: { taskId: task.taskId, inputResponses } },
            UpdateTaskResultSchema,
          );
        } catch {
          // Failed delivery: un-mark these keys so the next poll retries them
          // (otherwise the handle livelocks on a permanently-pending task).
          for (const k of Object.keys(inputResponses)) answered.delete(k);
        }
      }
    };

    const pollOnce = async (): Promise<DetailedTask> => {
      const task = await conn.sdk.request(
        { method: "tasks/get", params: { taskId: seed.taskId } },
        GetTaskResultSchema,
      );
      this.writeTaskSnapshot(server, task, context);
      return task;
    };

    const ensureLoop = (): void => {
      if (loop || settled) return;
      loop = (async () => {
        // Seed status may already be terminal (server settled before answering).
        if (isDetailed(seed) && settle(seed)) return;
        for (;;) {
          let task: DetailedTask;
          try {
            task = await pollOnce();
          } catch (err) {
            rejectResult(this.toError(err, server, "protocol"));
            settled = true;
            return;
          }
          if (settle(task)) return;
          await answerInputs(task);
          const beat = task.pollIntervalMs ?? this.taskPollMs;
          await new Promise((r) => setTimeout(r, beat));
        }
      })();
    };

    return {
      taskId: seed.taskId,
      server,
      task: () => this.cache.getSnapshot(key)?.data as Task | undefined,
      subscribe: (fn) => {
        ensureLoop();
        return this.cache.subscribe(key, () => {
          const t = this.cache.getSnapshot(key)?.data as Task | undefined;
          if (t) fn(t);
        });
      },
      result: () => {
        ensureLoop();
        return result;
      },
      cancel: async () => {
        await this.cancelTask(seed.taskId, server, context);
      },
    };
  }

  /** Fetch a task's current status (tasks/get) and refresh the cached snapshot. */
  async getTask(taskId: string, server: string, context?: CallContext): Promise<Task> {
    await this.wake(server);
    const conn = this.req(server);
    this.assertTasksCallable(conn);
    const task = await conn.sdk.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);
    this.writeTaskSnapshot(server, task, context);
    return task;
  }

  /**
   * @deprecated `tasks/list` was removed by the tasks extension redesign
   * (SEP-2663, 2026-07-28) — track task ids from `callToolTask` handles.
   * Always throws.
   */
  async listTasks(server: string): Promise<Task[]> {
    throw new MCPError(
      "protocol",
      "tasks/list was removed by the tasks extension (SEP-2663); track task ids from callToolTask handles",
      server,
    );
  }

  /**
   * Retrieve a task's result.
   *
   * @deprecated `tasks/result` was removed by the tasks extension redesign
   * (SEP-2663) — the result is inlined on the terminal `tasks/get` snapshot.
   * This emulates the old blocking behavior by polling `tasks/get`.
   */
  async getTaskResult<R = unknown>(taskId: string, server: string): Promise<R> {
    await this.wake(server);
    const conn = this.req(server);
    this.assertTasksCallable(conn);
    for (;;) {
      const task = await conn.sdk.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);
      this.writeTaskSnapshot(server, task);
      if (task.status === "completed") return (task.result ?? {}) as R;
      if (task.status === "failed") {
        const e = task.error as { message?: string; code?: number; data?: unknown } | undefined;
        throw new MCPError("protocol", e?.message ?? `task ${taskId} failed`, server, e?.code, e?.data);
      }
      if (task.status === "cancelled") throw new MCPError("cancelled", `task ${taskId} was cancelled`, server);
      await new Promise((r) => setTimeout(r, task.pollIntervalMs ?? this.taskPollMs));
    }
  }

  /** Cancel a running task (tasks/cancel) and refresh the cached snapshot. */
  async cancelTask(taskId: string, server: string, context?: CallContext): Promise<void> {
    await this.wake(server);
    const conn = this.req(server);
    this.assertTasksCallable(conn);
    await conn.sdk.request({ method: "tasks/cancel", params: { taskId } }, CancelTaskResultSchema);
    await this.getTask(taskId, server, context).catch(() => {});
  }

  /**
   * Notify every connected server that the client's roots changed (roots/list_changed).
   *
   * @deprecated Roots are deprecated as of 2026-07-28 (SEP-2577), and the
   * notification does not exist on modern connections (those are skipped;
   * modern-era roots are delivered per multi-round-trip round).
   */
  async notifyRootsChanged(): Promise<void> {
    await Promise.allSettled(
      this.connections()
        .filter((c) => c.era !== "modern")
        .map((c) => c.sdk.sendRootsListChanged()),
    );
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
    this.serverHandlers.delete(name);
    this.cache.markStaleByServer(name);
    this.bumpServerState();
  }

  // ── readOnly tool as a cached query (useToolResult) ──────────────────────
  async queryTool<A extends Record<string, unknown>, R = unknown>(
    name: string,
    args: A,
    opts: QueryToolOpts = {},
  ): Promise<R> {
    await this.wake(this.hint(name, opts.server));
    const { server, def } = this.router.resolveTool(name, opts.server);
    const op: Operation = { kind: "query", server, target: def.name, def, args, context: opts.context, state: {} };
    return this.run(op, (o) => this.execQuery<R>(server, def, o.args as A, { ...opts, context: o.context })) as Promise<R>;
  }

  private execQuery<R = unknown>(server: string, def: Tool, args: Record<string, unknown>, opts: QueryToolOpts): Promise<R> {
    const conn = this.req(server);
    const key = { kind: "toolResult", server, tool: def.name, argsHash: argsHash(args), partition: opts.context?.partition } as const;

    const existing = this.cache.inflight(key);
    if (existing) return existing as Promise<R>;

    this.cache.setFetching(key);
    const abort = new AbortController();
    const p = (async () => {
      try {
        const fromL2 = await this.l2ReadThrough(key);
        if (fromL2) return fromL2.data as R;
        const meta = this.withMeta(conn, opts.context);
        const result = (await this.withRetry(() =>
          conn.sdk.callTool({ name: def.name, arguments: args, ...(meta ? { _meta: meta } : {}) }, {
            signal: abort.signal,
            toolDefinition: def,
            ...this.defaultRequestOptions, ...(opts.requestOptions ?? {}),
          }),
        )) as R;
        const extra = typeof opts.providesTags === "function" ? opts.providesTags(result) : opts.providesTags ?? [];
        const tags = [serverTag(server), ...extra];
        const scope = cacheScope(result);
        this.cache.write(key, result, { gcTime: opts.gcTime, staleTime: cacheTtl(result), tags, scope });
        this.l2WriteThrough(key, result, tags, scope);
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

  async getPrompt(name: string, args: Record<string, unknown>, server?: string, opts: { context?: CallContext } = {}) {
    await this.wake(server);
    // Prompts have their own registry — route by which server offers the prompt, not by tool.
    const s = server ?? this.connections().find((c) => c.prompts.has(name))?.name;
    if (!s) throw new Error(`No connected server offers prompt "${name}"`);
    const conn = this.req(s);
    // MCP prompt arguments are string-valued; coerce so callers can pass numbers/bools.
    const stringArgs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]));
    const meta = this.withMeta(conn, opts.context);
    return conn.sdk.getPrompt({ name, arguments: stringArgs, ...(meta ? { _meta: meta } : {}) });
  }

  // ── internals ──────────────────────────────────────────────────────────
  /**
   * Ref-counted protocol subscriptions driven by cache subscriber count:
   * legacy era = `resources/subscribe`/`unsubscribe`; modern era = the observed
   * set feeds the connection's `subscriptions/listen` filter (SEP-2575).
   */
  private async maybeProtocolSubscribe(key: CacheKey, want: boolean): Promise<void> {
    if (key.kind !== "resource") return;
    const { server, uri } = key;
    const conn = this.conns.get(server);
    if (!conn?.supports("resources.subscribe")) return;
    if (conn.era === "modern") {
      this.cache.setProtocolSubscribed(key, want);
      const observed = new Set<string>();
      for (const e of this.cache.entriesForDevtools()) {
        if (e.protocolSubscribed && e.cacheKey.kind === "resource" && e.cacheKey.server === server) {
          observed.add(e.cacheKey.uri);
        }
      }
      conn.listen.setObserved(observed);
      return;
    }
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
    if (err instanceof MCPError) return err; // don't re-wrap (scoped/idempotent paths)

    // v2 SDK-local errors (string SdkErrorCode). Brand-based hasInstance makes
    // this safe across package copies (client + server in one process).
    if (err instanceof SdkError) {
      const message = err.message;
      // v2 wraps a caller abort as SdkError(RequestTimeout) with the AbortError
      // message — classify by cause, not code, so aborts stay "cancelled".
      const aborted = /\babort(ed)?\b|\bcancell?ed\b/i.test(message);
      const kindFor: MCPError["kind"] = aborted
        ? "cancelled"
        : err.code === SdkErrorCode.RequestTimeout
          ? "timeout"
          : err.code === SdkErrorCode.ConnectionClosed ||
              err.code === SdkErrorCode.NotConnected ||
              err.code === SdkErrorCode.SendFailed ||
              err instanceof SdkHttpError ||
              err.code === SdkErrorCode.EraNegotiationFailed
            ? "transport"
            : "protocol";
      const out = new MCPError(kindFor, message, server, undefined, {
        sdkCode: err.code,
        ...(err instanceof SdkHttpError ? { status: err.status } : {}),
        ...(err.data !== undefined ? { cause: err.data } : {}),
      });
      if (err.stack) out.stack = err.stack;
      return out;
    }

    // Wire-level JSON-RPC errors: numeric codes. -32602-with-uri (2026-07-28)
    // and legacy -32002 are both resource-not-found.
    if (err instanceof ProtocolError) {
      const uri =
        err instanceof ResourceNotFoundError
          ? err.uri
          : err.code === -32002
            ? ((err.data as { uri?: string } | undefined)?.uri ?? undefined)
            : undefined;
      const out = new MCPError(kind, err.message, server, err.code, err.data, uri);
      if (err.stack) out.stack = err.stack;
      return out;
    }

    const e = err as { message?: string; code?: number; data?: unknown; name?: string };
    const message = e?.message ?? String(err);
    // Classify aborts as "cancelled" — callers gate retry/toast logic on the kind.
    const resolved: MCPError["kind"] =
      e?.name === "AbortError" || /\babort(ed)?\b|\bcancell?ed\b/i.test(message) ? "cancelled" : kind;
    const out = new MCPError(resolved, message, server, e?.code, e?.data);
    if (err instanceof Error && err.stack) out.stack = err.stack;
    return out;
  }
}

/** A Task carrying detail fields (inputRequests/result/error) — i.e. from tasks/get. */
function isDetailed(task: Task): task is DetailedTask {
  return "result" in task || "error" in task || "inputRequests" in task || TERMINAL_STATUSES.includes(task.status);
}
