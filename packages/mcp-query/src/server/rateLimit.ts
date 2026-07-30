// Concurrency limiter interceptor — cap in-flight operations per key and queue the
// rest (backpressure), so a backend aggregator doesn't overwhelm an upstream. Small +
// dependency-free; for token-bucket rate limiting plug bottleneck onto the same seam.

import type { Operation, RequestInterceptor } from "../core/interceptors.js";

export interface RateLimitOptions {
  /** Max concurrent operations per key. Default 8. */
  concurrency?: number;
  /**
   * Group operations into buckets sharing a concurrency budget. Default `(op) => op.peer`
   * — one budget per upstream server, matching pre-0.2.0 behavior exactly. Pass e.g.
   * `(op) => \`${op.peer}::${op.context?.partition ?? ""}\`` for per-tenant isolation on a
   * shared server/gateway (a busy tenant's calls no longer throttle every other tenant's).
   * Called on every op; keep it cheap and pure.
   */
  keyFn?: (op: Operation) => string;
}

export interface RateLimit {
  interceptor: RequestInterceptor;
  /**
   * Drop all state for keys produced (by `keyFn`) while `op.peer === server` — for cleanup
   * when a server is removed at runtime (e.g. `MCPClient.removeServer`). Correct for any
   * `keyFn`, including one that doesn't encode `server` in the key at all: key→server
   * provenance is tracked explicitly, not inferred by string-matching the key.
   */
  dropServer(server: string): void;
}

export function rateLimit(opts: RateLimitOptions = {}): RateLimit {
  const max = opts.concurrency ?? 8;
  const keyFn = opts.keyFn ?? ((op: Operation) => op.peer);
  const active = new Map<string, number>();
  const queues = new Map<string, Array<() => void>>();
  const keyServer = new Map<string, string>();

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
      const k = keyFn(op);
      keyServer.set(k, op.peer);
      await acquire(k);
      try {
        return await next(op);
      } finally {
        release(k);
      }
    },
    dropServer(server) {
      for (const [k, s] of keyServer) {
        if (s === server) {
          active.delete(k);
          queues.delete(k);
          keyServer.delete(k);
        }
      }
    },
  };
}
