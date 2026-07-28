// ListenManager — the modern-era (2026-07-28) delivery channel. The revision
// replaces unsolicited notifications and `resources/subscribe` with ONE
// client-opened `subscriptions/listen` stream carrying an opt-in filter.
// Deliveries dispatch to the client's existing `setNotificationHandler`
// registrations, so the relist/invalidation plumbing is untouched — this class
// only owns the stream lifecycle:
//
//  - the filter is FIXED at listen time, so changing the observed-resource set
//    means opening a replacement stream, then closing the old one (the overlap
//    gives at-least-once delivery; duplicate list_changed is absorbed by the
//    relist generation guard, resource-updated by idempotent invalidation);
//  - a `closed: 'remote'` (unexpected drop) re-listens with backoff;
//  - a `closed: 'graceful'` (server shutdown signal) re-listens once after the
//    first backoff step — the transport usually drops right after, and the
//    connection-level reconnect takes over from there.

import type { Client, McpSubscription, SubscriptionFilter } from "@modelcontextprotocol/client";

export interface ListenManagerOptions {
  /** Which list_changed families to request (from the server's advertised caps). */
  listFilters: () => { tools: boolean; prompts: boolean; resources: boolean };
  /** Backoff for re-listen after an unexpected stream loss (reuses the connection's). */
  retryDelay?: (attempt: number) => number;
  onError?: (err: unknown) => void;
  /** Debounce (ms) for observed-set changes collapsing into one re-listen. */
  debounceMs?: number;
}

export class ListenManager {
  private current?: McpSubscription;
  private observed = new Set<string>();
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopped = true;
  private opening = false;
  private reopenQueued = false;

  constructor(
    private readonly client: () => Client,
    private readonly opts: ListenManagerOptions,
  ) {}

  /** The filter the server actually agreed to honor (undefined while no stream is open). */
  get honoredFilter(): SubscriptionFilter | undefined {
    return this.current?.honoredFilter;
  }

  /** Replace the observed-resource set; re-listens (debounced) when it changed. */
  setObserved(uris: Iterable<string>): void {
    const next = new Set(uris);
    if (next.size === this.observed.size && [...next].every((u) => this.observed.has(u))) return;
    this.observed = next;
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), this.opts.debounceMs ?? 50);
    this.debounceTimer.unref?.();
  }

  /** Open the stream (no-op when the desired filter is empty). Called after connect. */
  async start(seedObserved?: Iterable<string>): Promise<void> {
    this.stopped = false;
    this.attempts = 0;
    if (seedObserved) this.observed = new Set(seedObserved);
    await this.refresh();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const cur = this.current;
    this.current = undefined;
    await cur?.close().catch(() => {});
  }

  private desiredFilter(): SubscriptionFilter | undefined {
    const f = this.opts.listFilters();
    const filter: SubscriptionFilter = {};
    if (f.tools) filter.toolsListChanged = true;
    if (f.prompts) filter.promptsListChanged = true;
    if (f.resources) filter.resourcesListChanged = true;
    if (this.observed.size) filter.resourceSubscriptions = [...this.observed];
    return Object.keys(filter).length ? filter : undefined;
  }

  /** Open a stream for the current desired filter, then retire the previous one. */
  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.opening) {
      // Collapse concurrent refreshes: the in-flight open finishes, then reruns once.
      this.reopenQueued = true;
      return;
    }
    const filter = this.desiredFilter();
    const old = this.current;
    if (!filter) {
      this.current = undefined;
      await old?.close().catch(() => {});
      return;
    }
    this.opening = true;
    try {
      const sub = await this.client().listen(filter);
      this.current = sub;
      this.attempts = 0;
      // Open-before-close: the overlap window loses nothing.
      await old?.close().catch(() => {});
      void sub.closed.then((cause) => {
        if (this.stopped || this.current !== sub) return; // superseded or shut down
        if (cause === "local") return;
        this.scheduleReopen();
      });
    } catch (err) {
      this.opts.onError?.(err);
      this.scheduleReopen();
    } finally {
      this.opening = false;
      if (this.reopenQueued) {
        this.reopenQueued = false;
        void this.refresh();
      }
    }
  }

  private scheduleReopen(): void {
    if (this.stopped || this.retryTimer) return;
    const attempt = this.attempts++;
    const delay = this.opts.retryDelay?.(attempt) ?? Math.min(30_000, 500 * 2 ** attempt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.refresh();
    }, delay);
    this.retryTimer.unref?.();
  }
}
