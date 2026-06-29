// MCPCache — the centerpiece. A reactive key->document store with:
//   - staleTime / gcTime          (TanStack Query)
//   - tag-based invalidation      (RTK Query providesTags / invalidatesTags)
//   - protocol-driven invalidation (resources/updated, *_list_changed)
//   - ref-counted subscribers      (drives gc AND protocol resources/subscribe)
//
// It is framework-agnostic; React bindings sit on top via useSyncExternalStore.

import { serializeKey, type CacheKey } from "./keys.js";
import { type Tag } from "./tags.js";
import type { MCPError } from "./types.js";

export interface CacheEntry<T = unknown> {
  key: string;
  /** The structured key — so consumers never have to parse `key`. */
  cacheKey: CacheKey;
  data?: T;
  error?: MCPError;
  status: "idle" | "fetching" | "success" | "error";
  isStale: boolean;
  updatedAt: number;
  staleTime: number;
  gcTime: number;
  tags: Set<Tag>;
  subscribers: number;
  /** Monotonic counter bumped on every emit — the value useSyncExternalStore observes. */
  version: number;
  /** Whether we've issued resources/subscribe for this entry (managed by the connection layer). */
  protocolSubscribed: boolean;
  /** In-flight request, for de-duping concurrent reads of the same key. */
  inflight?: Promise<unknown>;
  /** Aborts the in-flight fetch when the last observer unsubscribes. */
  abort?: AbortController;
  gcTimer?: ReturnType<typeof setTimeout>;
}

export interface CacheWriteOpts {
  tags?: Tag[];
  staleTime?: number;
  gcTime?: number;
}

export interface CachePatch {
  key: CacheKey;
  /** Produce the next data from the previous (optimistic update). */
  recipe: (prev: unknown) => unknown;
}

type Listener = () => void;

export interface CacheEvents {
  onSubscribe?: (entry: CacheEntry) => void; // first subscriber arrived -> maybe resources/subscribe
  onUnsubscribe?: (entry: CacheEntry) => void; // last subscriber left -> maybe resources/unsubscribe
  onInvalidate?: (keys: string[]) => void; // for devtools + auto-refetch wiring
  onInvalidateTags?: (tags: Tag[]) => void; // for distributed (L2) invalidation broadcast
}

const DEFAULT_STALE = 30_000; // freshly fetched data is fresh for 30s by default
const DEFAULT_GC = 5 * 60_000;

export class MCPCache {
  private entries = new Map<string, CacheEntry>();
  private tagIndex = new Map<Tag, Set<string>>(); // tag -> entry keys
  private listeners = new Map<string, Set<Listener>>(); // entry key -> hook listeners
  private globalListeners = new Set<() => void>();
  private now: () => number;
  private events: CacheEvents;

  constructor(opts: { now?: () => number; events?: CacheEvents } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.events = opts.events ?? {};
  }

  // ── reads ──────────────────────────────────────────────────────────────
  getSnapshot(key: CacheKey): CacheEntry | undefined {
    return this.entries.get(serializeKey(key));
  }

  /** The value useSyncExternalStore observes — changes on every emit for this key. */
  getVersion(key: CacheKey): number {
    return this.entries.get(serializeKey(key))?.version ?? 0;
  }

  /** True if the entry is missing, errored, or older than its staleTime. */
  isStale(key: CacheKey): boolean {
    const e = this.getSnapshot(key);
    if (!e || e.status !== "success") return true;
    return e.isStale || this.now() - e.updatedAt > e.staleTime;
  }

  // ── useSyncExternalStore plumbing ────────────────────────────────────────
  /** Returns an unsubscribe fn. Ref-counts subscribers and drives gc + protocol subscribe. */
  subscribe(key: CacheKey, fn: Listener): () => void {
    const k = serializeKey(key);
    const entry = this.ensure(key);
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(fn);
    entry.subscribers++;
    if (entry.gcTimer) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = undefined;
    }
    if (entry.subscribers === 1) this.events.onSubscribe?.(entry);

    return () => {
      set!.delete(fn);
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      if (entry.subscribers === 0) {
        this.events.onUnsubscribe?.(entry);
        this.scheduleGc(entry);
      }
    };
  }

  // ── writes ───────────────────────────────────────────────────────────────
  setFetching(key: CacheKey): void {
    const e = this.ensure(key);
    e.status = e.status === "success" ? "success" : "fetching";
    e.inflight ??= undefined;
    this.emit(e.key);
  }

  write<T>(key: CacheKey, data: T, opts: CacheWriteOpts = {}): void {
    const e = this.ensure(key);
    // Structural sharing: if the new data deep-equals the old, keep the old reference
    // and refresh staleness WITHOUT bumping the version — so observers don't re-render
    // on a no-op update (e.g. a resources/updated whose bytes didn't actually change).
    const unchanged = e.status === "success" && structuralEqual(e.data, data);
    if (!unchanged) e.data = data;
    e.error = undefined;
    e.status = "success";
    e.isStale = false;
    e.updatedAt = this.now();
    if (opts.staleTime != null) e.staleTime = opts.staleTime;
    if (opts.gcTime != null) e.gcTime = opts.gcTime;
    this.reindexTags(e, opts.tags);
    if (!unchanged) this.emit(e.key);
  }

  // ── in-flight de-duplication + abort-when-unobserved ─────────────────────
  /** The promise of an in-flight fetch for this key, if any (for request de-duping). */
  inflight(key: CacheKey): Promise<unknown> | undefined {
    return this.entries.get(serializeKey(key))?.inflight;
  }
  setInflight(key: CacheKey, promise: Promise<unknown> | undefined, abort?: AbortController): void {
    const e = this.ensure(key);
    e.inflight = promise;
    e.abort = promise ? abort : undefined;
  }
  /** Abort an in-flight fetch (called when the last observer leaves). */
  abortInflight(key: CacheKey): void {
    const e = this.entries.get(serializeKey(key));
    if (e?.subscribers === 0 && e.abort) e.abort.abort();
  }

  setError(key: CacheKey, error: MCPError): void {
    const e = this.ensure(key);
    e.error = error;
    e.status = "error";
    this.emit(e.key);
  }

  // ── invalidation ───────────────────────────────────────────────────────
  /** RTK Query-style: mark every entry carrying any of these tags stale. */
  invalidateTags(tags: Tag[], broadcast = true): void {
    const touched: string[] = [];
    for (const tag of tags) {
      for (const k of this.tagIndex.get(tag) ?? []) {
        const e = this.entries.get(k);
        if (e) {
          e.isStale = true;
          touched.push(k);
        }
      }
    }
    for (const k of touched) this.emit(k);
    if (touched.length) this.events.onInvalidate?.(touched);
    // Declared invalidations broadcast to other nodes; protocol-driven ones stay local
    // (each node gets its own resources/updated). `broadcast=false` breaks remote loops.
    if (broadcast) this.events.onInvalidateTags?.(tags);
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

  // ── optimistic updates ───────────────────────────────────────────────────
  /** Apply patches, return a rollback fn. Used by useTool before a mutation resolves. */
  patch(patches: CachePatch[]): () => void {
    const prev: Array<{ key: string; data: unknown; existed: boolean }> = [];
    for (const p of patches) {
      const e = this.ensure(p.key);
      prev.push({ key: e.key, data: e.data, existed: e.status === "success" });
      e.data = p.recipe(e.data);
      this.emit(e.key);
    }
    return () => {
      for (const snap of prev) {
        const e = this.entries.get(snap.key);
        if (!e) continue;
        e.data = snap.data;
        this.emit(e.key);
      }
    };
  }

  // ── internals ──────────────────────────────────────────────────────────
  /** Mark whether the connection layer has an active resources/subscribe for this key. */
  setProtocolSubscribed(key: CacheKey, value: boolean): void {
    const e = this.entries.get(serializeKey(key));
    if (e) e.protocolSubscribed = value;
  }

  entriesForDevtools(): CacheEntry[] {
    return [...this.entries.values()];
  }

  /** Fires on any change to any entry — used by the persister. */
  subscribeAll(fn: () => void): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  // ── persistence (offline / SSR hydration) ─────────────────────────────────
  /** A serializable snapshot of successful entries (data + tags + age). */
  dehydrate(): { entries: Array<{ cacheKey: CacheKey; data: unknown; tags: Tag[]; updatedAt: number }> } {
    return {
      entries: [...this.entries.values()]
        .filter((e) => e.status === "success")
        .map((e) => ({ cacheKey: e.cacheKey, data: e.data, tags: [...e.tags], updatedAt: e.updatedAt })),
    };
  }
  /** Restore a snapshot. Entries keep their original age, so staleTime still applies. */
  hydrate(snapshot: { entries: Array<{ cacheKey: CacheKey; data: unknown; tags: Tag[]; updatedAt: number }> }): void {
    for (const s of snapshot.entries) {
      this.write(s.cacheKey, s.data, { tags: s.tags });
      const e = this.entries.get(serializeKey(s.cacheKey));
      if (e) e.updatedAt = s.updatedAt; // preserve age rather than "now"
    }
  }

  private ensure(key: CacheKey): CacheEntry {
    const k = serializeKey(key);
    let e = this.entries.get(k);
    if (!e) {
      e = {
        key: k,
        cacheKey: key,
        status: "idle",
        isStale: true,
        updatedAt: 0,
        staleTime: DEFAULT_STALE,
        gcTime: DEFAULT_GC,
        tags: new Set(),
        subscribers: 0,
        version: 0,
        protocolSubscribed: false,
      };
      this.entries.set(k, e);
    }
    return e;
  }

  private reindexTags(e: CacheEntry, tags?: Tag[]): void {
    if (!tags) return;
    for (const tag of e.tags) this.tagIndex.get(tag)?.delete(e.key);
    e.tags = new Set(tags);
    for (const tag of tags) {
      let set = this.tagIndex.get(tag);
      if (!set) this.tagIndex.set(tag, (set = new Set()));
      set.add(e.key);
    }
  }

  private scheduleGc(e: CacheEntry): void {
    if (e.protocolSubscribed) return; // never gc a live subscription
    e.gcTimer = setTimeout(() => {
      if (e.subscribers > 0) return;
      for (const tag of e.tags) this.tagIndex.get(tag)?.delete(e.key);
      this.entries.delete(e.key);
      this.listeners.delete(e.key);
    }, e.gcTime);
  }

  private emit(key: string): void {
    const e = this.entries.get(key);
    if (e) e.version++;
    for (const fn of this.listeners.get(key) ?? []) fn();
    for (const fn of this.globalListeners) fn();
  }
}

/** Deep structural equality for cache structural sharing. */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => structuralEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      structuralEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
