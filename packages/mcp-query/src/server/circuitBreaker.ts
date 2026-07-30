// Circuit breaker interceptor — after N consecutive failures for a key, fail fast for a
// cooldown instead of hammering a dead upstream; then half-open (one trial). The complement
// to retry/reconnect. Small + dependency-free; for richer policies plug cockatiel/opossum
// onto the same interceptor seam.

import type { Operation, RequestInterceptor } from "../core/interceptors.js";

export interface CircuitOptions {
  /** Consecutive failures before opening. Default 5. */
  threshold?: number;
  /** Cooldown before a half-open trial, ms. Default 10_000. */
  cooldownMs?: number;
  now?: () => number;
  /**
   * Group operations into buckets sharing breaker state. Default `(op) => op.peer` — one
   * breaker per upstream server, matching pre-0.2.0 behavior exactly. Pass e.g.
   * `(op) => \`${op.peer}::${op.context?.partition ?? ""}\`` for per-tenant isolation on a
   * shared server/gateway (one tenant tripping the breaker doesn't fail-fast every other
   * tenant). Called on every op; keep it cheap and pure.
   */
  keyFn?: (op: Operation) => string;
}

export class CircuitOpenError extends Error {
  readonly code = -32002;
  constructor(key: string) {
    super(`circuit open for "${key}"`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreaker {
  interceptor: RequestInterceptor;
  /**
   * Drop all state for keys produced (by `keyFn`) while `op.peer === server` — for cleanup
   * when a server is removed at runtime. Correct for any `keyFn` — see `RateLimit.dropServer`'s
   * doc in `rateLimit.ts` for why this can't be string-prefix matching.
   */
  dropServer(server: string): void;
}

export function circuitBreaker(opts: CircuitOptions = {}): CircuitBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldown = opts.cooldownMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const keyFn = opts.keyFn ?? ((op: Operation) => op.peer);
  const state = new Map<string, { failures: number; openedAt?: number }>();
  const keyServer = new Map<string, string>();

  return {
    interceptor: async (op, next) => {
      const k = keyFn(op);
      keyServer.set(k, op.peer);
      const s = state.get(k) ?? { failures: 0 };
      if (s.openedAt !== undefined) {
        if (now() - s.openedAt < cooldown) throw new CircuitOpenError(k);
        s.openedAt = undefined; // half-open: allow one trial through
      }
      try {
        const r = await next(op);
        state.set(k, { failures: 0 });
        return r;
      } catch (e) {
        const failures = s.failures + 1;
        state.set(k, { failures, openedAt: failures >= threshold ? now() : undefined });
        throw e;
      }
    },
    dropServer(server) {
      for (const [k, s] of keyServer) {
        if (s === server) {
          state.delete(k);
          keyServer.delete(k);
        }
      }
    },
  };
}
