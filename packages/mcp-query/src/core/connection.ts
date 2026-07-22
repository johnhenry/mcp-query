// ServerConnection — one per MCP server. Wraps the official SDK Client and adds
// the LSP-client lifecycle: capability negotiation, *dynamic registration*
// (list_changed == LSP's client/registerCapability), reconnection with capability
// re-negotiation, and cache reconciliation.
//
// 2026-07-28: a connection now has an ERA. Legacy connections (2025-x) keep the
// `initialize` handshake, unsolicited notifications, `resources/subscribe`, and
// optional session resumption. Modern connections negotiate via `server/discover`
// (SDK `versionNegotiation`), receive change notifications on a client-opened
// `subscriptions/listen` stream (ListenManager), and have no sessions/ping/
// logging-setLevel. The same notification handlers serve both delivery paths.

import { Client, type InputRequiredOptions, type Transport, type VersionNegotiationOptions } from "@modelcontextprotocol/client";

import type { MCPCache } from "./cache.js";
import { clientCapabilities, installHandlers } from "./handlers.js";
import { instrumentTransport, type TrafficEvent } from "./instrument.js";
import { listKeyFor } from "./keys.js";
import { ListenManager } from "./listen.js";
import type { SessionStore } from "./sessionStore.js";
import { capsTag, serverTag } from "./tags.js";
import { TASKS_EXT, TaskNotificationParamsSchema } from "./tasksExt.js";
import type {
  ClientInfo,
  HostHandlers,
  Prompt,
  ProtocolEra,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  ServerState,
  Tool,
} from "./types.js";

/**
 * Passed to the transport factory when resuming a persisted session. A Streamable HTTP
 * factory should forward `sessionId` to its transport options (which makes the SDK skip
 * `initialize`) and pass `protocolVersion` so the transport sends its version header.
 *
 * @deprecated 2025-era sessions only — the 2026-07-28 revision removed sessions
 * (SEP-2567). Functional on legacy connections.
 */
export interface TransportContext {
  sessionId?: string;
  protocolVersion?: string;
}

export interface ConnectionConfig {
  /** A transport factory so we can rebuild it on reconnect (stdio/StreamableHTTP/SSE). */
  transport: (ctx?: TransportContext) => Transport;
  /**
   * Protocol version negotiation (2026-07-28). Defaults to the client-wide
   * setting (MCPClientConfig.versionNegotiation), ultimately `{ mode: "auto" }`:
   * probe with `server/discover`, fall back losslessly to the 2025 handshake
   * against a legacy server. Pin `{ mode: { pin: "2026-07-28" } }` for
   * modern-only, or `{ mode: "legacy" }` to skip the probe entirely.
   */
  versionNegotiation?: VersionNegotiationOptions;
  /** Multi-round-trip auto-fulfilment knobs (maxRounds etc.); default SDK behavior. */
  inputRequired?: InputRequiredOptions;
  /**
   * Opt-in session resumption (Streamable HTTP): persist the transport's session id so a
   * reload or reconnect resumes the same server-side session instead of re-`initialize`-ing
   * into a fresh one. A resumed session is validated with a `ping` and falls back to a
   * fresh init if the server has forgotten it.
   *
   * @deprecated 2025-era sessions only — the 2026-07-28 revision removed sessions
   * (SEP-2567). A modern connection never sets `transport.sessionId`, so the
   * store never writes; resumption applies only against legacy servers.
   */
  sessionStore?: SessionStore;
  /** Cap reconnection attempts; backoff is exponential. */
  maxRetries?: number;
  /** ms before reconnect attempt N (0-based). Default: exponential capped at 30s. */
  retryDelay?: (attempt: number) => number;
  /** Connect on first use instead of eagerly at client.connect() (server-side). */
  lazy?: boolean;
  /** With `lazy`, disconnect after this many ms idle; reconnect on next use. */
  idleMs?: number;
}

export interface ConnectionDeps {
  cache: MCPCache;
  /** Host handlers (sampling/elicitation/roots); registering one advertises the capability. */
  handlers: HostHandlers;
  /** Identity advertised to servers. Defaults to mcp-query's own. */
  clientInfo?: ClientInfo;
  /** Client-wide negotiation default (per-connection config wins). */
  defaultVersionNegotiation?: VersionNegotiationOptions;
  /** Client-wide MRTR default (per-connection config wins). */
  defaultInputRequired?: InputRequiredOptions;
  onStateChange?: (server: string, state: ServerState, caps?: ServerCapabilities) => void;
  onCapabilitiesChanged?: (server: string, kind: "tools" | "resources" | "prompts") => void;
  /** Server-emitted log messages (notifications/message). */
  onLog?: (server: string, entry: { level: string; logger?: string; data: unknown }) => void;
  /** Every JSON-RPC message in/out (for the devtools message log). */
  onMessage?: (server: string, ev: TrafficEvent) => void;
}

export class ServerConnection {
  state: ServerState = "idle";
  capabilities: ServerCapabilities = {};
  /** serverInfo.version — the server's own version string, NOT the MCP protocol version. */
  protocolVersion = "";
  /** True when the current connection resumed a persisted session (skipped `initialize`). */
  resumed = false;

  // Live registries — kept current by list_changed handlers (dynamic registration).
  tools = new Map<string, Tool>();
  resources = new Map<string, Resource>();
  templates: ResourceTemplate[] = [];
  prompts = new Map<string, Prompt>();

  /** Modern-era change-notification stream owner (idle on legacy connections). */
  readonly listen: ListenManager;

  private client: Client;
  private retries = 0;
  private closing = false;
  private reconnectPending = false;
  private relistGen: Partial<Record<"tools" | "resources" | "prompts", number>> = {};
  private idle = false; // slept by idle eviction (re-wakes on next use)
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readyPromise?: Promise<void>;
  private rawTransport?: Transport;

  constructor(
    readonly name: string,
    private cfg: ConnectionConfig,
    private deps: ConnectionDeps,
  ) {
    this.client = this.makeClient();
    this.listen = new ListenManager(() => this.client, {
      listFilters: () => ({
        tools: !!this.capabilities.tools?.listChanged,
        prompts: !!this.capabilities.prompts?.listChanged,
        resources: !!this.capabilities.resources?.listChanged,
      }),
      retryDelay: this.cfg.retryDelay,
      onError: () => {
        /* listen loss is recoverable; state surfaces via honoredFilter */
      },
    });
  }

  /** Build an SDK client that advertises exactly the capabilities our handlers back. */
  private makeClient(): Client {
    const client = new Client(this.deps.clientInfo ?? { name: "mcpq", version: "0.1.0" }, {
      capabilities: clientCapabilities(this.deps.handlers),
      versionNegotiation: this.cfg.versionNegotiation ?? this.deps.defaultVersionNegotiation ?? { mode: "auto" },
      inputRequired: this.cfg.inputRequired ?? this.deps.defaultInputRequired,
    });
    installHandlers(client, this.deps.handlers);
    // Mid-session disconnect (transport dropped) -> attempt reconnect, unless we
    // closed on purpose or are already cycling. Mirrors an editor relaunching a
    // crashed language server.
    client.onclose = () => {
      if (this.closing || this.idle) return; // intentional close / idle sleep — don't reconnect
      if (this.state === "ready" || this.state === "degraded") this.scheduleReconnect();
    };
    return client;
  }

  get isLazy(): boolean {
    return this.cfg.lazy === true;
  }

  /**
   * The negotiated protocol generation: "modern" = 2026-07-28+, "legacy" =
   * 2025-era `initialize` (including resumed sessions, which are legacy by
   * construction). "legacy" before the connection is established.
   */
  get era(): ProtocolEra {
    return this.client.getProtocolEra() === "modern" ? "modern" : "legacy";
  }

  /**
   * Lazy connect: ensure the connection is up before use. No-op for eager (non-lazy)
   * connections (those connect via client.connect()). Re-wakes after idle eviction.
   */
  async ensureReady(): Promise<void> {
    if (!this.isLazy) return;
    this.touch();
    if (this.state === "ready" || this.state === "degraded") return;
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (this.idle || this.state === "closed") {
          this.idle = false;
          this.closing = false;
          this.client = this.makeClient(); // the previous client was closed
        }
        await this.connect();
        this.touch();
      })().finally(() => {
        this.readyPromise = undefined;
      });
    }
    return this.readyPromise;
  }

  /** Idle eviction: close the transport (without `closing`) so the next use re-wakes it. */
  private async sleep(): Promise<void> {
    if (this.state !== "ready" && this.state !== "degraded") return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.idle = true;
    await this.listen.stop();
    await this.client.close().catch(() => {});
    this.setState("idle");
  }

  private touch(): void {
    if (!this.isLazy || !this.cfg.idleMs) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.sleep(), this.cfg.idleMs);
    this.idleTimer.unref?.(); // don't keep the process alive
  }

  get sdk(): Client {
    return this.client;
  }

  /** Build the transport, instrumented for the message log when a tap is present. */
  private makeTransport(ctx?: TransportContext): Transport {
    const t = this.cfg.transport(ctx);
    this.rawTransport = t; // the instrumented wrapper doesn't forward `sessionId`
    return this.deps.onMessage ? instrumentTransport(t, (ev) => this.deps.onMessage!(this.name, ev)) : t;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      await this.establish();
      this.setState("initializing");
      await this.refreshAll();
      await this.startListen();
      this.retries = 0;
      this.setState(this.isDegraded() ? "degraded" : "ready");
    } catch (err) {
      this.setState("failed");
      this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Connect the SDK client:
   *  1. Resume the persisted (legacy-era) session when a `sessionStore` still
   *     holds one — `prior: { kind: "legacy" }` keeps the 'auto' probe from
   *     running before the resume, and the session is validated with a `ping`.
   *  2. Otherwise a fresh connect: reuse the last negotiation verdict when we
   *     have one (`prior`), else probe/handshake per `versionNegotiation`.
   */
  private async establish(): Promise<void> {
    const store = this.cfg.sessionStore;
    const saved = store ? await store.get() : undefined;
    this.resumed = false;
    if (saved?.sessionId) {
      try {
        this.wireNotifications();
        await this.client.connect(
          this.makeTransport({ sessionId: saved.sessionId, protocolVersion: saved.protocolVersion }),
          { prior: { kind: "legacy" } },
        );
        this.capabilities = saved.capabilities ?? {};
        this.protocolVersion = saved.serverVersion ?? "";
        // The resume path skips `initialize`, leaving the SDK client capability-
        // blind — and v2 soft-guards its list verbs on server capabilities
        // (returning empty lists). No public restore API exists in 2.0.0-beta.5,
        // so seed the private field from the persisted record. Beta gap; revisit.
        (this.client as unknown as { _serverCapabilities?: ServerCapabilities })._serverCapabilities =
          saved.capabilities ?? {};
        await this.client.ping();
        this.resumed = true;
        return;
      } catch {
        // Don't clear the record here: this failure may be a transient network/connect
        // error rather than a confirmed "server forgot the session", and discarding a
        // still-valid session id would cost future resumability for nothing. A successful
        // fresh connect below overwrites the record anyway; a failed one leaves the old
        // (possibly still-valid) id in place for the next attempt.
        await this.client.close().catch(() => {});
        this.client = this.makeClient();
      }
    }
    this.wireNotifications();
    // Every fresh connect re-negotiates (probe + capability fetch): reconnects
    // MUST see capability changes, so a cached era verdict (`prior`) is not
    // reused here — correctness over the probe round trip. (Callers that want
    // zero-probe reconnects can pin versionNegotiation instead.)
    await this.client.connect(this.makeTransport());
    this.capabilities = this.client.getServerCapabilities() ?? {};
    this.protocolVersion = this.client.getServerVersion()?.version ?? "";
    const sessionId = this.rawTransport?.sessionId;
    if (store && sessionId) {
      await store.set({
        sessionId,
        capabilities: this.capabilities,
        protocolVersion: (this.rawTransport as { protocolVersion?: string }).protocolVersion,
        serverVersion: this.protocolVersion,
      });
    }
  }

  /** Open the modern-era listen stream, seeding observed resources from the cache. */
  private async startListen(): Promise<void> {
    if (this.era !== "modern") return;
    const observed = this.observedResourceUris();
    // Awaited: the connection is not live-invalidation-ready until the server
    // acks the stream (notifications published before the ack are lost). A
    // failed listen still resolves — the manager retries with backoff and the
    // connection degrades to poll-only semantics meanwhile.
    await this.listen.start(observed);
  }

  /** Resource URIs with a live protocol subscription (drives the listen filter). */
  private observedResourceUris(): string[] {
    const uris: string[] = [];
    for (const e of this.cache.entriesForDevtools()) {
      if (e.protocolSubscribed && e.cacheKey.kind === "resource" && e.cacheKey.server === this.name) {
        uris.push(e.cacheKey.uri);
      }
    }
    return uris;
  }

  /** Re-initialize on reconnect — capabilities MAY have changed, so reconcile. */
  private async reconnect(): Promise<void> {
    this.setState("reconnecting");
    this.cache.markStaleByServer(this.name); // volatile reads no longer trusted
    const before = this.capabilities;
    try {
      this.client.onclose = undefined; // stop the dying client from scheduling another reconnect
      await this.listen.stop();
      this.client = this.makeClient();
      await this.establish(); // resumes the session where possible, else re-negotiates
      this.reconcileCapabilities(before, this.capabilities);
      await this.refreshAll(); // re-list: surface may have changed
      await this.resubscribeObserved(); // legacy: re-establish resources/subscribe
      await this.startListen(); // modern: reopen the listen stream
      this.cache.invalidateTags([
        capsTag(this.name, "tools"),
        capsTag(this.name, "resources"),
        capsTag(this.name, "prompts"),
      ]);
      this.retries = 0;
      this.setState(this.isDegraded() ? "degraded" : "ready");
    } catch (err) {
      // Surface the failure — a silent retry loop is undebuggable from the outside.
      console.warn(`[mcp-query] reconnect "${this.name}" failed (attempt ${this.retries}):`, err);
      this.scheduleReconnect();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    await this.listen.stop();
    await this.client.close().catch(() => {});
    this.setState("closed");
  }

  // ── dynamic registration: list_changed == LSP client/registerCapability ───
  // The same registrations serve both eras: unsolicited notifications on legacy
  // connections, listen-stream deliveries on modern ones.
  private wireNotifications(): void {
    this.client.setNotificationHandler("notifications/tools/list_changed", async () => {
      await this.relist("tools");
    });
    this.client.setNotificationHandler("notifications/resources/list_changed", async () => {
      await this.relist("resources");
    });
    this.client.setNotificationHandler("notifications/prompts/list_changed", async () => {
      await this.relist("prompts");
    });
    // The free-invalidation path: server tells us exactly which resource changed.
    this.client.setNotificationHandler("notifications/resources/updated", (n) => {
      this.cache.onResourceUpdated(this.name, n.params.uri);
    });
    // Server-side logging stream (legacy; modern only for requests carrying the
    // logLevel _meta key — see CallContext.logLevel).
    this.client.setNotificationHandler("notifications/message", (n) => {
      this.deps.onLog?.(this.name, { level: n.params.level, logger: n.params.logger, data: n.params.data });
    });
    // Tasks extension (SEP-2663): unsolicited task snapshots. Custom method —
    // registered with an explicit schema; params ARE a DetailedTask.
    this.client.setNotificationHandler("notifications/tasks", { params: TaskNotificationParamsSchema }, (params) => {
      this.cache.write({ kind: "task", server: this.name, taskId: params.taskId }, params, {
        tags: [serverTag(this.name)],
      });
    });
  }

  async relist(kind: "tools" | "resources" | "prompts"): Promise<void> {
    // Concurrent list_changed storms race their re-list responses: without ordering, a
    // stale response can be applied AFTER the newest one and stick. Tag each re-list
    // with a generation; only the response for the latest generation may apply.
    const gen = (this.relistGen[kind] = (this.relistGen[kind] ?? 0) + 1);
    // v2 list calls auto-aggregate all pages; 'refresh' keeps the SDK's derived
    // tools index warm without ever serving us its cached copy (mcp-query's
    // MCPCache is the caching layer here).
    let ttlMs: number | undefined;
    if (kind === "tools" && this.capabilities.tools) {
      const res = await this.client.listTools(undefined, { cacheMode: "refresh" });
      if (gen !== this.relistGen[kind]) return; // superseded by a newer list_changed
      this.tools = indexBy(res.tools, "name");
      ttlMs = cacheTtl(res);
    } else if (kind === "resources" && this.capabilities.resources) {
      const res = await this.client.listResources(undefined, { cacheMode: "refresh" });
      if (gen !== this.relistGen[kind]) return;
      this.resources = indexBy(res.resources, "uri");
      ttlMs = cacheTtl(res);
    } else if (kind === "prompts" && this.capabilities.prompts) {
      const res = await this.client.listPrompts(undefined, { cacheMode: "refresh" });
      if (gen !== this.relistGen[kind]) return;
      this.prompts = indexBy(res.prompts, "name");
      ttlMs = cacheTtl(res);
    }
    // Write the catalog into the cache (tagged) so list-observing hooks re-render and
    // tag-based invalidation has something to hit. Server-provided ttlMs (SEP-2549)
    // becomes the entry's staleTime.
    const list =
      kind === "tools"
        ? [...this.tools.values()]
        : kind === "resources"
          ? [...this.resources.values()]
          : [...this.prompts.values()];
    this.cache.write(listKeyFor(this.name, kind), list, { tags: [capsTag(this.name, kind)], staleTime: ttlMs });
    this.deps.onCapabilitiesChanged?.(this.name, kind);
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([
      this.capabilities.tools && this.relist("tools"),
      this.capabilities.resources && this.relist("resources"),
      this.capabilities.prompts && this.relist("prompts"),
    ]);
    if (this.capabilities.resources) {
      const res = await this.client
        .listResourceTemplates(undefined, { cacheMode: "refresh" })
        .catch(() => ({ resourceTemplates: [] as ResourceTemplate[] }));
      this.templates = res.resourceTemplates;
      // Cache templates (tagged with the resources catalog) so useResourceTemplates re-renders.
      this.cache.write({ kind: "templateList", server: this.name }, this.templates, {
        tags: [capsTag(this.name, "resources")],
        staleTime: cacheTtl(res),
      });
    }
  }

  /**
   * Set the server-side logging verbosity (logging/setLevel).
   *
   * @deprecated The Logging feature is deprecated as of 2026-07-28 (SEP-2577),
   * and `logging/setLevel` does not exist on modern connections (no-op there).
   * Use `CallContext.logLevel` / `MCPClientConfig.defaultLogLevel` to request
   * per-call log delivery on the modern era.
   */
  async setLogLevel(level: string): Promise<void> {
    if (this.era === "modern") return; // method absent from the 2026-07-28 registry
    if (this.capabilities.logging) await this.client.setLoggingLevel(level as never).catch(() => {});
  }

  // ── reconnection reconciliation ───────────────────────────────────────────
  private reconcileCapabilities(before: ServerCapabilities, after: ServerCapabilities): void {
    // Lost a capability we relied on? Drop its cached catalog so hooks see "unavailable".
    if (before.resources?.subscribe && !after.resources?.subscribe) {
      // downgrade: callers that asked subscribe:true must fall back to polling (see useResource)
      this.cache.invalidateTags([serverTag(this.name)]);
    }
  }

  private async resubscribeObserved(): Promise<void> {
    if (this.era === "modern") return; // modern: the listen stream carries these (startListen)
    if (!this.capabilities.resources?.subscribe) return;
    for (const uri of this.observedResourceUris()) {
      await this.client.subscribeResource({ uri }).catch(() => {});
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  supports(feature: "tools" | "resources" | "prompts" | "resources.subscribe" | "tasks"): boolean {
    if (feature === "resources.subscribe") return !!this.capabilities.resources?.subscribe;
    if (feature === "tasks") return !!this.capabilities.extensions?.[TASKS_EXT];
    return !!this.capabilities[feature];
  }

  private get cache(): MCPCache {
    return this.deps.cache;
  }

  private isDegraded(): boolean {
    // App-configurable in practice; here: connected but exposes nothing useful.
    return !this.capabilities.tools && !this.capabilities.resources && !this.capabilities.prompts;
  }

  private setState(s: ServerState): void {
    this.state = s;
    this.deps.onStateChange?.(this.name, s, this.capabilities);
  }

  private scheduleReconnect(): void {
    if (this.reconnectPending) return; // collapse duplicate close signals into one attempt
    const max = this.cfg.maxRetries ?? 6;
    if (this.retries >= max) {
      this.setState("failed");
      return;
    }
    this.reconnectPending = true;
    // A dropped live connection is not "ready" while we wait out the backoff — flip the
    // state immediately so health UIs don't report a dead server as healthy for up to 30s.
    // (Initial-connect failures keep their "failed" state until the retry actually runs.)
    if (this.state === "ready" || this.state === "degraded") this.setState("reconnecting");
    const attempt = this.retries++;
    const delay = this.cfg.retryDelay?.(attempt) ?? Math.min(30_000, 500 * 2 ** attempt);
    setTimeout(() => {
      this.reconnectPending = false;
      void this.reconnect();
    }, delay);
  }
}

// ── small utilities ──────────────────────────────────────────────────────────
function indexBy<T>(items: T[], key: keyof T): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(String(it[key]), it);
  return m;
}

/**
 * Read the SEP-2549 `ttlMs` freshness hint off a cacheable result body. The
 * fields are wire-only (hidden from the public types but passed through by the
 * loose schemas); 2025-era results never carry them ⇒ undefined ⇒ defaults.
 *
 * Deliberate deviation: `ttlMs: 0` (the v2 SDK's server-side stamp when a
 * handler sets no hint — the field is required on the 2026 wire) is treated as
 * "no signal" rather than "immediately stale". mcp-query staleness is advisory
 * (it schedules background refetch, it does not gate correctness), and honoring
 * the ubiquitous default 0 would disable client-side freshness entirely against
 * hint-less servers. Positive hints are honored and clamped like the SDK (24h).
 */
export function cacheTtl(result: unknown): number | undefined {
  const ttl = (result as { ttlMs?: unknown })?.ttlMs;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) return undefined;
  return Math.min(ttl, 24 * 60 * 60 * 1000);
}

/** Read the SEP-2549 `cacheScope` off a cacheable result body. */
export function cacheScope(result: unknown): "public" | "private" | undefined {
  const scope = (result as { cacheScope?: unknown })?.cacheScope;
  return scope === "public" || scope === "private" ? scope : undefined;
}
