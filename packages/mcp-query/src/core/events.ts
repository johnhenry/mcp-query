// Events extension (`io.modelcontextprotocol/events`, SEP-3415) — the client side.
//
//   - `list()`   `events/list`, cached under the SEP-2549 ttl/scope helpers, per server and per
//                `client.scope()` partition; invalidated by `notifications/events/list_changed`.
//   - `open()`   an {@link EventSubscription}: a poll loop over `events/poll` that resumes from the
//                last cursor (also across a reconnect), honours the server's `nextPollMs` / `hasMore`
//                (with a floor), dedupes on `eventId`, and reports `truncated: true` as an explicit
//                gap in its snapshot instead of swallowing it.
//
// Every wire call (the list and each poll) is a `kind: "event"` operation through the interceptor
// chain (see MCPClient), so a gateway sees and can veto/redact each batch.
//
// Poll only. `events/stream` (push) and `events/subscribe` (webhook) are specified but not driven
// here; see docs/api.md. Event payloads are untrusted data (spec "Security Considerations"):
// treat `data` like a tool result before it reaches a model.

import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import type { MCPCache } from "./cache.js";
import type { CallContext } from "./client.js";
import { cacheScope, cacheTtl, type ServerConnection } from "./connection.js";
import {
  EVENTS_EXT,
  ListEventsResultSchema,
  PollEventsResultSchema,
  TERMINAL_EVENT_CODES,
  EVENTS_ERROR,
  type EventOccurrence,
  type EventType,
  type PollEventsResult,
} from "./eventsExt.js";
import { sdkSupportsEventMethods } from "./eventsProbe.js";
import type { Operation } from "./interceptors.js";
import type { CacheKey } from "./keys.js";
import { serverTag, type Tag } from "./tags.js";
import { MCPError } from "./types.js";

export { EVENTS_EXT };
export type { EventOccurrence, EventType };

/** Tag carried by every cached event-type listing of `server`; invalidated by `notifications/events/list_changed`. */
export const eventsTag = (server: string): Tag => `events:${server}`;

// ── public types ─────────────────────────────────────────────────────────────

/** An event type, tagged with the server that offers it. */
export interface ServerEventType extends EventType {
  server: string;
}

export interface ListEventsOpts {
  /** Override the freshness window (ms); default is the server's `ttlMs`, else the cache default. */
  staleTime?: number;
  /** Bypass the cache and re-fetch. */
  force?: boolean;
  signal?: AbortSignal;
  /** `partition` namespaces the cache (use `client.scope({ partition })`). */
  context?: CallContext;
  /** With no `server`: called when one server's listing fails (that server is skipped). */
  onError?: (server: string, error: MCPError) => void;
}

/** Why a subscription reports a gap. The wire does not distinguish causes (spec "Gaps and truncated"). */
export interface EventGap {
  /** `Date.now()` when the poll that reported it returned. */
  at: number;
  /** The cursor the client supplied; events after it may have been skipped. */
  previousCursor: string | null;
  /** The fresh cursor the server resumed from. */
  cursor: string | null;
  reason: "truncated";
}

export type EventsStatus =
  /** Created; first poll not answered yet. */
  | "starting"
  /** The last poll succeeded. */
  | "live"
  /** The last poll failed transiently; retrying from the last cursor. */
  | "reconnecting"
  /** Ended by the server or an interceptor (not found, forbidden, denied, ...); see `error`. */
  | "error"
  /** Closed by `close()`, the abort signal, or the client shutting down. */
  | "closed";

/** Immutable view of a subscription; a new object is produced on every change (useSyncExternalStore-safe). */
export interface EventsSnapshot {
  server: string;
  name: string;
  status: EventsStatus;
  /** Delivered events, oldest first, deduped on `eventId`, capped to the newest `maxBuffer`. */
  events: readonly EventOccurrence[];
  /** Number of events delivered so far (not capped; `events.length` is). */
  delivered: number;
  /** The resume position: persist it and pass it as `cursor` next time. `null` = none (no replay, or not yet known). */
  cursor: string | null;
  /** Every `truncated: true` the server reported, oldest first. */
  gaps: readonly EventGap[];
  /** True once any gap was reported. Re-read authoritative state with tools if it matters. */
  truncated: boolean;
  /** The server's last suggested poll interval (ms). */
  nextPollMs?: number;
  /** `Date.now()` of the last successful poll. */
  lastPollAt?: number;
  /** Set when `status` is `"error"`, and carries the last transient failure while `"reconnecting"`. */
  error?: MCPError;
}

export interface EventsOpts {
  /** `"poll"` (default). `"stream"` is specified but not implemented: it rejects with an `MCPError`. */
  mode?: "poll" | "stream";
  /** Resume from this position (a cursor you persisted); `null`/absent = start from now. */
  cursor?: string | null;
  /** Ends the subscription when aborted. */
  signal?: AbortSignal;
  /** Bound replay on resume: the server starts from the later of `cursor` and `now - maxAgeMs`. Ignored by servers for a null cursor. */
  maxAgeMs?: number;
  /** Cap the events per poll; the server answers `hasMore: true` for the rest. */
  maxEvents?: number;
  /** Floor for the wait between polls (ms), so a misbehaving server cannot induce a tight loop. Default 1000 (the spec's). */
  pollFloorMs?: number;
  /** Wait between polls when the server sent no `nextPollMs` (ms). Client-chosen; default 5000. */
  fallbackPollMs?: number;
  /** Events kept in `snapshot.events`. Default 500. */
  maxBuffer?: number;
  /** `eventId`s remembered for dedupe. Default 2000. */
  dedupeWindow?: number;
  /** Backoff after a transient failure: `base * 2^n`, capped at `max` (ms). Default 500 / 30000. */
  retry?: { baseMs?: number; maxMs?: number };
  /** Called for each new (deduped) event, in order. Throwing is caught and logged. */
  onEvent?: (event: EventOccurrence) => void;
  /** Called when a poll reports `truncated: true`. */
  onGap?: (gap: EventGap) => void;
  /** Called whenever the resume cursor changes: persist it durably to resume after a restart. */
  onCursor?: (cursor: string | null) => void;
  /** `partition` namespaces the type-listing cache; `meta` rides on every request's `_meta`. */
  context?: CallContext;
}

/**
 * A live subscription to one event type with one set of arguments. `subscribe` / `getSnapshot` are
 * `useSyncExternalStore`-shaped. Created by `client.events(...)`, started immediately, ended by `close()`.
 */
export interface EventSubscription {
  readonly server: string;
  readonly name: string;
  subscribe(listener: () => void): () => void;
  getSnapshot(): EventsSnapshot;
  /** Poll now instead of waiting out the interval (no-op while a poll is in flight or once ended). */
  refresh(): void;
  /** Stop polling. Idempotent. */
  close(): void;
  /** Settles when the subscription has ended (closed or terminal error); never rejects. */
  readonly done: Promise<void>;
}

// ── the controller ───────────────────────────────────────────────────────────

/** What the controller needs from MCPClient (closures over its private members). */
export interface EventsHost {
  cache: MCPCache;
  connection(server: string): ServerConnection | undefined;
  connections(): ServerConnection[];
  /** Wake a possibly lazy server. */
  wake(server: string): Promise<void>;
  /** MCPClient's SDK-error -> MCPError mapping. */
  toError(err: unknown, server: string): MCPError;
  /** Run a `kind: "event"` operation through the interceptor chain. */
  run(op: Operation, exec: (op: Operation) => Promise<unknown>): Promise<unknown>;
  /** `client.listEvents(server, opts)`: the cached listing, run through the interceptor chain as a `kind: "event"` operation. */
  listTypes(server: string, opts?: ListEventsOpts): Promise<ServerEventType[]>;
  /** Request `_meta` from a CallContext (caller meta, log level). */
  meta(conn: ServerConnection, context?: CallContext): Record<string, unknown> | undefined;
}

type Cacheable = { ttlMs?: number; cacheScope?: "public" | "private" };

const MAX_LIST_PAGES = 100;

export class EventsController {
  private readonly active = new Set<EventSubscription>();

  constructor(private readonly host: EventsHost) {}

  /** `events/list` for one server, cached. (The union over servers is assembled by MCPClient so each server is its own chain operation.) */
  async list(server: string, opts: ListEventsOpts = {}): Promise<ServerEventType[]> {
    const key = this.listKey(server, opts.context);
    const hit = this.fresh<ServerEventType[]>(key, opts);
    if (hit) return hit;
    return this.dedupe(key, async () => {
      // Inside the dedupe so "no such server / no extension / wrong era" lands on the cache entry (hooks show it).
      const conn = await this.ready(server);
      const events: EventType[] = [];
      let cursor: string | undefined;
      let last: Cacheable = {};
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await this.request(
          conn,
          "events/list",
          cursor ? { cursor } : {},
          ListEventsResultSchema,
          opts.context,
          opts.signal,
        );
        events.push(...res.events);
        last = res as Cacheable;
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      const tagged: ServerEventType[] = events.map((e) => ({ ...e, server }));
      this.host.cache.write(key, tagged, {
        staleTime: opts.staleTime ?? cacheTtl(last),
        tags: [serverTag(server), eventsTag(server)],
        scope: cacheScope(last),
      });
      return tagged;
    });
  }

  /** Mark every cached event-type listing of `server` stale (`notifications/events/list_changed`). */
  invalidate(server: string): void {
    this.host.cache.invalidateTags([eventsTag(server)], false);
  }

  /** The cache key of `server`'s listing (hooks read it). */
  listKey(server: string, context?: CallContext): CacheKey {
    return { kind: "eventList", server, partition: context?.partition };
  }

  /** Start a poll subscription. Throws synchronously on a programmer error (unknown server, unsupported mode). */
  open(server: string, name: string, input: Record<string, unknown>, opts: EventsOpts = {}): EventSubscription {
    if (opts.mode === "stream") {
      throw new MCPError(
        "protocol",
        `events mode "stream" (events/stream) is not implemented in this version of mcp-query; use mode "poll". ` +
          `Push needs the id of the in-flight events/stream request to route its notifications, which the SDK's request() does not expose.`,
        server,
      );
    }
    if (opts.mode !== undefined && opts.mode !== "poll") {
      throw new MCPError("protocol", `unknown events mode ${JSON.stringify(opts.mode)} (expected "poll")`, server);
    }
    if (!this.host.connection(server)) {
      const known = this.host.connections().map((c) => c.name).join(", ") || "(none)";
      throw new MCPError("protocol", `unknown server "${server}"; configured: ${known}`, server);
    }
    const sub = new PollSubscription(this, this.host, server, name, input, opts);
    this.active.add(sub);
    void sub.done.then(() => this.active.delete(sub));
    return sub;
  }

  /** End every live subscription (client close / drain). */
  closeAll(): void {
    for (const s of [...this.active]) s.close();
  }

  // ── used by PollSubscription ───────────────────────────────────────────────

  /** Resolve the connection and check the extension can be used on it; throws an MCPError that says why not. */
  async ready(server: string): Promise<ServerConnection> {
    await this.host.wake(server);
    const conn = this.host.connection(server);
    if (!conn) {
      const known = this.host.connections().map((c) => c.name).join(", ") || "(none)";
      throw new MCPError("protocol", `unknown server "${server}"; configured: ${known}`, server);
    }
    await this.assertCallable(conn);
    return conn;
  }

  async assertCallable(conn: ServerConnection): Promise<void> {
    if (!conn.supports("events")) {
      throw new MCPError(
        "protocol",
        `server "${conn.name}" does not advertise the events extension (capabilities.extensions["${EVENTS_EXT}"])`,
        conn.name,
      );
    }
    if (conn.era !== "modern") {
      throw new MCPError(
        "protocol",
        `events need a 2026-07-28 connection (the extension requires protocol 2026-07-28 or later); "${conn.name}" negotiated the 2025 era. ` +
          `Configure versions/versionNegotiation to allow 2026-07-28 for this server.`,
        conn.name,
      );
    }
    if (!(await sdkSupportsEventMethods(conn.sdk))) {
      throw new MCPError(
        "protocol",
        `events are not callable on a 2026-07-28 connection with the installed @modelcontextprotocol/client: ` +
          `it blocks ${EVENTS_EXT} requests (events/*) on that protocol version. Upgrade @modelcontextprotocol/client.`,
        conn.name,
      );
    }
  }

  /** One `events/*` request, declaring the extension in this request's client capabilities. */
  request<S extends { parse(v: unknown): unknown }>(
    conn: ServerConnection,
    method: string,
    params: Record<string, unknown>,
    schema: S,
    context?: CallContext,
    signal?: AbortSignal,
  ): Promise<ReturnType<S["parse"]>> {
    const meta = {
      ...(this.host.meta(conn, context) ?? {}),
      // The envelope's capabilities are replaced as a whole, so carry the client's own plus the extension.
      [CLIENT_CAPABILITIES_META_KEY]: conn.clientCapabilitiesWith(EVENTS_EXT),
    };
    return conn.sdk
      .request({ method, params: { ...params, _meta: meta } } as never, schema as never, signal ? { signal } : undefined)
      .catch((err: unknown) => {
        throw this.host.toError(err, conn.name);
      }) as Promise<ReturnType<S["parse"]>>;
  }

  // ── cache plumbing (same shape as the skills controller) ───────────────────

  private fresh<T>(key: CacheKey, opts: { force?: boolean }): T | undefined {
    if (opts.force) return undefined;
    const snap = this.host.cache.getSnapshot(key);
    if (snap?.status === "success" && !this.host.cache.isStale(key)) return snap.data as T;
    return undefined;
  }

  private dedupe<T>(key: CacheKey, run: () => Promise<T>): Promise<T> {
    const existing = this.host.cache.inflight(key) as Promise<T> | undefined;
    if (existing) return existing;
    const server = key.server;
    this.host.cache.setFetching(key);
    const p = (async () => {
      try {
        return await run();
      } catch (err) {
        const mapped = err instanceof MCPError ? err : this.host.toError(err, server);
        this.host.cache.setError(key, mapped);
        throw mapped;
      } finally {
        this.host.cache.setInflight(key, undefined);
      }
    })();
    this.host.cache.setInflight(key, p);
    return p;
  }
}

// ── the poll subscription ────────────────────────────────────────────────────

class PollSubscription implements EventSubscription {
  readonly done: Promise<void>;

  private snap: EventsSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly ac = new AbortController();
  private cursor: string | null;
  private readonly seen = new Set<string>();
  private failures = 0;
  private wake?: () => void;
  private sleeping?: ReturnType<typeof setTimeout>;
  private ended = false;
  private readonly floorMs: number;
  private readonly fallbackMs: number;
  private readonly maxBuffer: number;
  private readonly dedupeWindow: number;
  private readonly retryBase: number;
  private readonly retryMax: number;

  constructor(
    private readonly controller: EventsController,
    private readonly host: EventsHost,
    readonly server: string,
    readonly name: string,
    private readonly input: Record<string, unknown>,
    private readonly opts: EventsOpts,
  ) {
    this.cursor = opts.cursor ?? null;
    this.floorMs = opts.pollFloorMs ?? 1000;
    this.fallbackMs = opts.fallbackPollMs ?? 5000;
    this.maxBuffer = Math.max(1, opts.maxBuffer ?? 500);
    this.dedupeWindow = Math.max(1, opts.dedupeWindow ?? 2000);
    this.retryBase = opts.retry?.baseMs ?? 500;
    this.retryMax = opts.retry?.maxMs ?? 30_000;
    this.snap = {
      server,
      name,
      status: "starting",
      events: [],
      delivered: 0,
      cursor: this.cursor,
      gaps: [],
      truncated: false,
    };
    if (opts.signal) {
      if (opts.signal.aborted) this.end("closed");
      else opts.signal.addEventListener("abort", () => this.close(), { once: true });
    }
    this.done = this.ended ? Promise.resolve() : this.run();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EventsSnapshot => this.snap;

  refresh(): void {
    this.wake?.();
  }

  close(): void {
    this.end("closed");
  }

  // ── the loop ───────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    try {
      await this.preflight();
      while (!this.ended) {
        let waitMs: number;
        try {
          waitMs = await this.pollOnce();
          this.failures = 0;
        } catch (err) {
          if (this.ended) break;
          const e = err instanceof MCPError ? err : this.host.toError(err, this.server);
          if (e.kind === "cancelled" && this.ac.signal.aborted) break;
          if (this.isTerminal(e)) {
            this.end("error", e);
            break;
          }
          this.patch({ status: "reconnecting", error: e });
          waitMs = Math.min(this.retryMax, this.retryBase * 2 ** Math.min(this.failures++, 20));
        }
        if (this.ended) break;
        await this.sleep(waitMs);
      }
    } catch (err) {
      // preflight (or anything unexpected) failed for good.
      if (!this.ended) this.end("error", err instanceof MCPError ? err : this.host.toError(err, this.server));
    }
  }

  /** Check the extension is usable and the event type is offered with poll delivery. */
  private async preflight(): Promise<void> {
    await this.controller.ready(this.server);
    const find = (types: ServerEventType[]) => types.find((t) => t.name === this.name);
    // Through the chain (client.listEvents), without this subscription's signal: closing it must not
    // leave a "cancelled" error on the shared cache entry.
    let type = find(await this.host.listTypes(this.server, { context: this.opts.context }));
    // The cached listing may predate a dynamic registration: look once more before giving up.
    type ??= find(await this.host.listTypes(this.server, { context: this.opts.context, force: true }));
    if (!type) {
      throw new MCPError("protocol", `server "${this.server}" offers no event type "${this.name}"`, this.server, EVENTS_ERROR.NotFound, {
        kind: "event",
      });
    }
    if (type.delivery.length > 0 && !type.delivery.includes("poll")) {
      throw new MCPError(
        "protocol",
        `event type "${this.name}" on "${this.server}" does not offer poll delivery (offers: ${type.delivery.join(", ")}); only poll is implemented`,
        this.server,
        EVENTS_ERROR.Unsupported,
        { feature: "deliveryMode", value: "poll" },
      );
    }
  }

  /** One `events/poll` through the interceptor chain; returns how long to wait before the next. */
  private async pollOnce(): Promise<number> {
    const conn = await this.controller.ready(this.server);
    const sent = this.cursor;
    const op: Operation = {
      kind: "event",
      peer: this.server,
      target: this.name,
      method: "events/poll",
      args: { ...this.input },
      context: this.opts.context,
      state: {},
    };
    const res = (await this.host.run(op, (o) =>
      this.controller.request(
        conn,
        "events/poll",
        {
          name: this.name,
          arguments: o.args ?? {},
          cursor: sent,
          // Spec: ignored for a null cursor; only send it when it can mean something.
          ...(sent !== null && this.opts.maxAgeMs !== undefined ? { maxAgeMs: this.opts.maxAgeMs } : {}),
          ...(this.opts.maxEvents !== undefined ? { maxEvents: this.opts.maxEvents } : {}),
        },
        PollEventsResultSchema,
        o.context,
        this.ac.signal,
      ),
    )) as PollEventsResult;
    if (this.ended) return 0;

    // Spec: an absent cursor is `null` (no replay): nothing to persist, always poll from now.
    const next = res.cursor ?? null;
    const fresh: EventOccurrence[] = [];
    for (const ev of res.events ?? []) {
      if (this.seen.has(ev.eventId)) continue;
      this.seen.add(ev.eventId);
      fresh.push(ev);
    }
    while (this.seen.size > this.dedupeWindow) this.seen.delete(this.seen.values().next().value as string);

    const gaps = res.truncated === true ? [...this.snap.gaps, { at: Date.now(), previousCursor: sent, cursor: next, reason: "truncated" as const }] : this.snap.gaps;
    const buffered = fresh.length ? [...this.snap.events, ...fresh].slice(-this.maxBuffer) : this.snap.events;
    this.cursor = next;
    this.patch({
      status: "live",
      events: buffered,
      delivered: this.snap.delivered + fresh.length,
      cursor: next,
      gaps,
      truncated: this.snap.truncated || res.truncated === true,
      nextPollMs: res.nextPollMs,
      lastPollAt: Date.now(),
      error: undefined,
    });
    if (next !== sent) this.safely(() => this.opts.onCursor?.(next), "onCursor");
    if (res.truncated === true) this.safely(() => this.opts.onGap?.(gaps[gaps.length - 1]!), "onGap");
    for (const ev of fresh) this.safely(() => this.opts.onEvent?.(ev), "onEvent");

    // hasMore: drain the backlog immediately, ignoring nextPollMs (still yields to the event loop).
    if (res.hasMore === true) return 0;
    return Math.max(this.floorMs, res.nextPollMs ?? this.fallbackMs);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private isTerminal(e: MCPError): boolean {
    if (e.code !== undefined && TERMINAL_EVENT_CODES.includes(e.code)) return true;
    // The client is shutting down or the call was refused by the chain's own bookkeeping.
    return /client is draining/i.test(e.message);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        if (this.sleeping) clearTimeout(this.sleeping);
        this.sleeping = undefined;
        this.wake = undefined;
        resolve();
      };
      this.wake = finish;
      this.sleeping = setTimeout(finish, ms);
      this.sleeping.unref?.();
    });
  }

  private end(status: "closed" | "error", error?: MCPError): void {
    if (this.ended) return;
    this.ended = true;
    this.ac.abort(new Error("events subscription closed"));
    this.wake?.();
    this.patch({ status, ...(error ? { error } : {}) });
  }

  private patch(p: Partial<EventsSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of [...this.listeners]) this.safely(l, "listener");
  }

  private safely(fn: () => void, what: string): void {
    try {
      fn();
    } catch (e) {
      console.error(`[mcp-query] events ${what} threw:`, e);
    }
  }
}
