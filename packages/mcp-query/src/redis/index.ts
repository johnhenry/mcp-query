// Redis-backed CacheStore for cross-process L2 + distributed invalidation. No hard
// dependency on a Redis client — you pass your own ioredis-like instances (a main one,
// and a second one for pub/sub, since a subscribed connection can't run other commands).
// Import from `mcp-query/redis`.

import type { CacheStore, StoredEntry } from "../core/cacheStore.js";

/** The slice of an ioredis-like client this adapter uses. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: "PX" | "EX", ttl?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

export interface RedisStoreOptions {
  /** Key prefix. Default "mcp-query:". */
  prefix?: string;
  /** TTL for stored entries, ms (optional). */
  ttlMs?: number;
  /** Pub/sub channel. Default "mcp-query:invalidate". */
  channel?: string;
}

/**
 * Build a CacheStore from a Redis client (and an optional separate subscriber client for
 * distributed invalidation). Entries are JSON; invalidations are published as tag arrays.
 */
export function createRedisCacheStore(redis: RedisLike, subscriber?: RedisLike, opts: RedisStoreOptions = {}): CacheStore {
  const prefix = opts.prefix ?? "mcp-query:";
  const channel = opts.channel ?? "mcp-query:invalidate";
  const k = (key: string) => prefix + key;

  return {
    async get(key) {
      const raw = await redis.get(k(key));
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as StoredEntry;
      } catch (e) {
        // A corrupted/foreign L2 entry is a cache miss, not a protocol error — the caller
        // (MCPClient.l2ReadThrough) falls back to fetching fresh from origin on `undefined`.
        // Letting this throw would fail the whole read instead.
        console.error(`[mcp-query] redis L2: corrupted cache entry at "${k(key)}", treating as a miss:`, e instanceof Error ? e.message : e);
        return undefined;
      }
    },
    async set(key, entry) {
      const v = JSON.stringify(entry);
      if (opts.ttlMs) await redis.set(k(key), v, "PX", opts.ttlMs);
      else await redis.set(k(key), v);
    },
    async delete(key) {
      await redis.del(k(key));
    },
    async publishInvalidation(tags) {
      await redis.publish(channel, JSON.stringify(tags));
    },
    subscribeInvalidations(cb) {
      const sub = subscriber ?? redis;
      void sub.subscribe(channel);
      const listener = (ch: string, message: string) => {
        if (ch !== channel) return;
        let tags: string[];
        try {
          tags = JSON.parse(message) as string[];
        } catch (e) {
          // A malformed message on the invalidation channel must not crash this listener
          // (it runs synchronously inside ioredis's event emitter) — log and drop it.
          console.error(`[mcp-query] redis L2: malformed invalidation message on "${channel}", ignoring:`, e instanceof Error ? e.message : e);
          return;
        }
        cb(tags);
      };
      sub.on("message", listener);
      return () => { /* ioredis: caller manages the subscriber lifecycle */ };
    },
  };
}
