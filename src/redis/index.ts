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
  /** Key prefix. Default "mcpq:". */
  prefix?: string;
  /** TTL for stored entries, ms (optional). */
  ttlMs?: number;
  /** Pub/sub channel. Default "mcpq:invalidate". */
  channel?: string;
}

/**
 * Build a CacheStore from a Redis client (and an optional separate subscriber client for
 * distributed invalidation). Entries are JSON; invalidations are published as tag arrays.
 */
export function createRedisCacheStore(redis: RedisLike, subscriber?: RedisLike, opts: RedisStoreOptions = {}): CacheStore {
  const prefix = opts.prefix ?? "mcpq:";
  const channel = opts.channel ?? "mcpq:invalidate";
  const k = (key: string) => prefix + key;

  return {
    async get(key) {
      const raw = await redis.get(k(key));
      return raw ? (JSON.parse(raw) as StoredEntry) : undefined;
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
        if (ch === channel) cb(JSON.parse(message) as string[]);
      };
      sub.on("message", listener);
      return () => { /* ioredis: caller manages the subscriber lifecycle */ };
    },
  };
}
