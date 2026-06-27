// ServerConnection — one per MCP server. Wraps the official SDK Client and adds
// the LSP-client lifecycle: capability negotiation, *dynamic registration*
// (list_changed == LSP's client/registerCapability), reconnection with capability
// re-negotiation, and cache reconciliation.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { MCPCache } from "./cache.js";
import { clientCapabilities, installHandlers } from "./handlers.js";
import { instrumentTransport, type TrafficEvent } from "./instrument.js";
import { listKeyFor } from "./keys.js";
import { capsTag, serverTag } from "./tags.js";
import type {
  ClientInfo,
  HostHandlers,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  ServerState,
  Tool,
} from "./types.js";

export interface ConnectionConfig {
  /** A transport factory so we can rebuild it on reconnect (stdio/StreamableHTTP/SSE). */
  transport: () => Transport;
  /** Cap reconnection attempts; backoff is exponential. */
  maxRetries?: number;
  /** ms before reconnect attempt N (0-based). Default: exponential capped at 30s. */
  retryDelay?: (attempt: number) => number;
}

export interface ConnectionDeps {
  cache: MCPCache;
  /** Host handlers (sampling/elicitation/roots); registering one advertises the capability. */
  handlers: HostHandlers;
  /** Identity advertised to the server during initialize. Defaults to mcp-query's own. */
  clientInfo?: ClientInfo;
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
  protocolVersion = "";

  // Live registries — kept current by list_changed handlers (dynamic registration).
  tools = new Map<string, Tool>();
  resources = new Map<string, Resource>();
  templates: ResourceTemplate[] = [];
  prompts = new Map<string, Prompt>();

  private client: Client;
  private retries = 0;
  private closing = false;
  private reconnectPending = false;

  constructor(
    readonly name: string,
    private cfg: ConnectionConfig,
    private deps: ConnectionDeps,
  ) {
    this.client = this.makeClient();
  }

  /** Build an SDK client that advertises exactly the capabilities our handlers back. */
  private makeClient(): Client {
    const client = new Client(
      this.deps.clientInfo ?? { name: "mcp-query", version: "0.0.1" },
      { capabilities: clientCapabilities(this.deps.handlers) },
    );
    installHandlers(client, this.deps.handlers);
    // Mid-session disconnect (transport dropped) -> attempt reconnect, unless we
    // closed on purpose or are already cycling. Mirrors an editor relaunching a
    // crashed language server.
    client.onclose = () => {
      if (this.closing) return;
      if (this.state === "ready" || this.state === "degraded") this.scheduleReconnect();
    };
    return client;
  }

  get sdk(): Client {
    return this.client;
  }

  /** Build the transport, instrumented for the message log when a tap is present. */
  private makeTransport(): Transport {
    const t = this.cfg.transport();
    return this.deps.onMessage ? instrumentTransport(t, (ev) => this.deps.onMessage!(this.name, ev)) : t;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    this.setState("connecting");
    try {
      this.wireNotifications();
      await this.client.connect(this.makeTransport());
      this.setState("initializing");
      // The SDK performs `initialize` during connect(); capabilities are now available.
      this.capabilities = this.client.getServerCapabilities() ?? {};
      this.protocolVersion = this.client.getServerVersion()?.version ?? "";
      await this.refreshAll();
      this.retries = 0;
      this.setState(this.isDegraded() ? "degraded" : "ready");
    } catch (err) {
      this.setState("failed");
      this.scheduleReconnect();
      throw err;
    }
  }

  /** Re-initialize on reconnect — capabilities MAY have changed, so reconcile. */
  private async reconnect(): Promise<void> {
    this.setState("reconnecting");
    this.cache.markStaleByServer(this.name); // volatile reads no longer trusted
    const before = this.capabilities;
    try {
      this.client.onclose = undefined; // stop the dying client from scheduling another reconnect
      this.client = this.makeClient();
      this.wireNotifications();
      await this.client.connect(this.makeTransport());
      this.capabilities = this.client.getServerCapabilities() ?? {};
      this.reconcileCapabilities(before, this.capabilities);
      await this.refreshAll(); // re-list: surface may have changed
      await this.resubscribeObserved(); // re-establish resources/subscribe for observed entries
      this.cache.invalidateTags([
        capsTag(this.name, "tools"),
        capsTag(this.name, "resources"),
        capsTag(this.name, "prompts"),
      ]);
      this.retries = 0;
      this.setState(this.isDegraded() ? "degraded" : "ready");
    } catch {
      this.scheduleReconnect();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.client.close().catch(() => {});
    this.setState("closed");
  }

  // ── dynamic registration: list_changed == LSP client/registerCapability ───
  private wireNotifications(): void {
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.relist("tools");
    });
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      await this.relist("resources");
    });
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      await this.relist("prompts");
    });
    // The free-invalidation path: server tells us exactly which resource changed.
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      this.cache.onResourceUpdated(this.name, n.params.uri);
    });
    // Server-side logging stream.
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      this.deps.onLog?.(this.name, { level: n.params.level, logger: n.params.logger, data: n.params.data });
    });
  }

  async relist(kind: "tools" | "resources" | "prompts"): Promise<void> {
    if (kind === "tools" && this.capabilities.tools) {
      this.tools = indexBy(await paginate((c) => this.client.listTools(c), (r) => r.tools), "name");
    } else if (kind === "resources" && this.capabilities.resources) {
      this.resources = indexBy(
        await paginate((c) => this.client.listResources(c), (r) => r.resources),
        "uri",
      );
    } else if (kind === "prompts" && this.capabilities.prompts) {
      this.prompts = indexBy(await paginate((c) => this.client.listPrompts(c), (r) => r.prompts), "name");
    }
    // Write the catalog into the cache (tagged) so list-observing hooks re-render and
    // tag-based invalidation has something to hit.
    const list =
      kind === "tools"
        ? [...this.tools.values()]
        : kind === "resources"
          ? [...this.resources.values()]
          : [...this.prompts.values()];
    this.cache.write(listKeyFor(this.name, kind), list, { tags: [capsTag(this.name, kind)] });
    this.deps.onCapabilitiesChanged?.(this.name, kind);
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([
      this.capabilities.tools && this.relist("tools"),
      this.capabilities.resources && this.relist("resources"),
      this.capabilities.prompts && this.relist("prompts"),
    ]);
    if (this.capabilities.resources) {
      this.templates = (await this.client.listResourceTemplates().catch(() => ({ resourceTemplates: [] })))
        .resourceTemplates as ResourceTemplate[];
      // Cache templates (tagged with the resources catalog) so useResourceTemplates re-renders.
      this.cache.write({ kind: "templateList", server: this.name }, this.templates, {
        tags: [capsTag(this.name, "resources")],
      });
    }
  }

  /** Set the server-side logging verbosity (logging/setLevel). */
  async setLogLevel(level: string): Promise<void> {
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
    if (!this.capabilities.resources?.subscribe) return;
    for (const e of this.cache.entriesForDevtools()) {
      if (e.protocolSubscribed && e.cacheKey.kind === "resource" && e.cacheKey.server === this.name) {
        await this.client.subscribeResource({ uri: e.cacheKey.uri }).catch(() => {});
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  supports(feature: "tools" | "resources" | "prompts" | "resources.subscribe"): boolean {
    if (feature === "resources.subscribe") return !!this.capabilities.resources?.subscribe;
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

/** Drain a cursor-paginated MCP list method (tools/list, resources/list, ...). */
async function paginate<R extends { nextCursor?: string }, T>(
  call: (params?: { cursor?: string }) => Promise<R>,
  pick: (r: R) => T[],
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(cursor ? { cursor } : undefined);
    out.push(...pick(page));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}
