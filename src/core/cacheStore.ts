// Pluggable L2 cache store — an *async* tier behind the synchronous in-memory L1
// (MCPCache, which the React hooks read via useSyncExternalStore and must stay sync).
// Used for cross-instance sharing + distributed invalidation in a multi-node backend.
// The hot read path (hooks) never touches L2; only the imperative read/query methods do.

export interface StoredEntry {
  data: unknown;
  tags: string[];
  updatedAt: number;
}

export interface CacheStore {
  get(key: string): Promise<StoredEntry | undefined>;
  set(key: string, entry: StoredEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Broadcast a tag invalidation to other nodes (declared invalidations only). */
  publishInvalidation?(tags: string[]): Promise<void>;
  /** Receive other nodes' invalidations. Returns unsubscribe. */
  subscribeInvalidations?(cb: (tags: string[]) => void): () => void;
}

/**
 * In-process store with a shared pub/sub bus — useful for tests and for several MCPClients
 * in one process. (Across processes, use a Redis-backed store; see `mcp-query/redis`.)
 */
export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, StoredEntry>();
  private subscribers = new Set<(tags: string[]) => void>();

  async get(key: string): Promise<StoredEntry | undefined> {
    return this.map.get(key);
  }
  async set(key: string, entry: StoredEntry): Promise<void> {
    this.map.set(key, entry);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async publishInvalidation(tags: string[]): Promise<void> {
    for (const cb of this.subscribers) cb(tags);
  }
  subscribeInvalidations(cb: (tags: string[]) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}
