// MCPCache — a thin, MCP-flavored subclass of @johnhenry/agent-query-core's QueryCache
// (issue #18: mcp-query now builds on the shared core rather than a parallel from-scratch
// cache). Adds back 4 convenience methods with no core equivalent (onResourceUpdated/
// onListChanged/markStaleByServer/clear — all one-line delegates to invalidateTags/a
// predicate-based clear), preserving the exact call signatures mcp-query's own code and
// consumers already use. CacheKey (keys.ts) needed no changes — QueryCache<K> is
// generic enough to parameterize directly with it and mcp-query's own serializeKey.
//
// Adopting core's cache also picks up 3 real bugfixes over mcp-query's prior from-scratch
// version, not just a rename: subscribe()'s returned unsubscribe fn re-fetches the
// entry fresh instead of holding a stale closure reference (fixes a subscriber
// double/undercount race across a remove()-then-rewrite); scheduleGc's fire-time
// recheck now also guards protocolSubscribed (previously only subscribers>0 was
// rechecked); ensure() seeds a freshly-recreated entry's subscriber count from the
// live listener-set size instead of hardcoding 0. CacheEntry also gains isOptimistic
// (unused by any consumer here today — harmless).

import { QueryCache, structuralEqual, type CacheEntry as CoreCacheEntry, type CacheEvents as CoreCacheEvents, type ExternalInvalidateEvent as CoreExternalInvalidateEvent, type CacheWriteOpts as CoreCacheWriteOpts, type CachePatch as CoreCachePatch } from "@johnhenry/agent-query-core";
import { serializeKey, type CacheKey } from "./keys.js";

export type CacheEntry<T = unknown> = CoreCacheEntry<T, CacheKey>;
export type CacheWriteOpts = CoreCacheWriteOpts;
export type CachePatch = CoreCachePatch<CacheKey>;
export type CacheEvents = CoreCacheEvents<CacheKey>;
export { structuralEqual };

export type ExternalInvalidateEvent = CoreExternalInvalidateEvent<CacheKey>;

export class MCPCache extends QueryCache<CacheKey> {
  private readonly externalListeners: Set<(event: ExternalInvalidateEvent) => void>;

  constructor(opts: { now?: () => number; events?: CacheEvents } = {}) {
    // core's `events` is constructor-only and single-handler; fan `onExternalInvalidate`
    // out to a listener set so bridges can attach to an already-built cache (#24).
    const listeners = new Set<(event: ExternalInvalidateEvent) => void>();
    super({
      serializeKey,
      now: opts.now,
      events: {
        ...opts.events,
        onExternalInvalidate: (event) => {
          opts.events?.onExternalInvalidate?.(event);
          for (const l of [...listeners]) l(event);
        },
      },
    });
    this.externalListeners = listeners;
  }

  /**
   * Register a listener fired on EVERY tag/key invalidation (protocol-driven or declared),
   * whether or not this cache holds a matching local entry. Usable after construction —
   * e.g. a TanStack adapter translating push invalidation into `invalidateQueries`.
   * Returns an unsubscribe function.
   */
  onExternalInvalidate(listener: (event: ExternalInvalidateEvent) => void): () => void {
    this.externalListeners.add(listener);
    return () => void this.externalListeners.delete(listener);
  }

  /** Protocol-driven: notifications/resources/updated -> invalidate that exact resource. */
  onResourceUpdated(server: string, uri: string): void {
    this.invalidateTags([`res:${server}:${uri}`], false);
  }

  /** Protocol-driven: notifications/<kind>/list_changed -> invalidate that catalog. */
  onListChanged(server: string, what: "tools" | "resources" | "prompts"): void {
    this.invalidateTags([`caps:${server}:${what}`], false);
  }

  /** Blunt invalidation used on reconnect when the capability set may have changed. */
  markStaleByServer(server: string): void {
    this.invalidateTags([`server:${server}`], false);
  }

  /**
   * Evict everything, or everything matching a filter — e.g. `clear({ server })` after
   * removing a server, `clear({ partition })` when a tenant session ends. Accepts
   * either the MCP-flavored filter-object form (preserved for source compatibility)
   * or core's generic predicate form directly — a superset of the base signature, so
   * this widens rather than narrows the override.
   */
  override clear(filterOrPredicate: { server?: string; partition?: string } | ((cacheKey: CacheKey) => boolean) = {}): void {
    if (typeof filterOrPredicate === "function") {
      super.clear(filterOrPredicate);
      return;
    }
    const filter = filterOrPredicate;
    super.clear((k) => (!filter.server || k.server === filter.server) && (!filter.partition || k.partition === filter.partition));
  }
}
