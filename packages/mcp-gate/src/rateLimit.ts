// Tenant-aware concurrency limiter — a fork of @johnhenry/mcpq/server's rateLimit(), keyed
// by `${server}::${partition}` instead of `server` alone, so a shared gate doesn't let one
// noisy tenant exhaust an upstream's concurrency budget for every other tenant. With no
// partition ever set (today's default, before #2's `partitionFrom` populates one), every key
// collapses to `${server}::`, which is byte-identical to the un-forked behavior — so this is
// a strict generalization, not a breaking change.
//
// Forked rather than parameterizing mcpq's own rateLimit()/circuitBreaker() with a `keyFn`
// option, to keep this entirely inside mcp-gate's own release (no coordinated mcpq bump). A
// follow-up mcpq issue (johnhenry/mcp-query#21) proposes that `keyFn` option upstream — if
// it lands, this file goes away.

import type { Operation, RequestInterceptor } from "@johnhenry/mcpq";

export interface RateLimitOptions {
  /** Max concurrent operations per (server, tenant) pair. Default 8. */
  concurrency?: number;
}

export interface TenantRateLimit {
  interceptor: RequestInterceptor;
  /** Drop all state for a removed upstream (called by Gate.removeUpstream). */
  dropServer(server: string): void;
}

const key = (op: Operation) => `${op.server}::${op.context?.partition ?? ""}`;

export function rateLimit(opts: RateLimitOptions = {}): TenantRateLimit {
  const max = opts.concurrency ?? 8;
  const active = new Map<string, number>();
  const queues = new Map<string, Array<() => void>>();

  const acquire = (k: string) =>
    new Promise<void>((resolve) => {
      const n = active.get(k) ?? 0;
      if (n < max) {
        active.set(k, n + 1);
        resolve();
      } else {
        const q = queues.get(k) ?? [];
        q.push(resolve);
        queues.set(k, q);
      }
    });

  const release = (k: string) => {
    const q = queues.get(k);
    if (q && q.length) q.shift()!(); // hand the slot to the next waiter (active unchanged)
    else active.set(k, Math.max(0, (active.get(k) ?? 1) - 1));
  };

  return {
    interceptor: async (op, next) => {
      const k = key(op);
      await acquire(k);
      try {
        return await next(op);
      } finally {
        release(k);
      }
    },
    dropServer(server) {
      const prefix = `${server}::`;
      for (const k of [...active.keys()]) if (k.startsWith(prefix)) active.delete(k);
      for (const k of [...queues.keys()]) if (k.startsWith(prefix)) queues.delete(k);
    },
  };
}
