// Concurrency limiter interceptor — cap in-flight operations per server and queue the
// rest (backpressure), so a backend aggregator doesn't overwhelm an upstream. Small +
// dependency-free; for token-bucket rate limiting plug bottleneck onto the same seam.

import type { RequestInterceptor } from "../core/interceptors.js";

export interface RateLimitOptions {
  /** Max concurrent operations per server. Default 8. */
  concurrency?: number;
}

export function rateLimit(opts: RateLimitOptions = {}): RequestInterceptor {
  const max = opts.concurrency ?? 8;
  const active = new Map<string, number>();
  const queues = new Map<string, Array<() => void>>();

  const acquire = (server: string) =>
    new Promise<void>((resolve) => {
      const n = active.get(server) ?? 0;
      if (n < max) {
        active.set(server, n + 1);
        resolve();
      } else {
        const q = queues.get(server) ?? [];
        q.push(resolve);
        queues.set(server, q);
      }
    });

  const release = (server: string) => {
    const q = queues.get(server);
    if (q && q.length) q.shift()!(); // hand the slot to the next waiter (active unchanged)
    else active.set(server, Math.max(0, (active.get(server) ?? 1) - 1));
  };

  return async (op, next) => {
    await acquire(op.server);
    try {
      return await next(op);
    } finally {
      release(op.server);
    }
  };
}
