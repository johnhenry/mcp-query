// Circuit breaker interceptor — after N consecutive failures for a server, fail fast for a
// cooldown instead of hammering a dead upstream; then half-open (one trial). The complement
// to retry/reconnect. Small + dependency-free; for richer policies plug cockatiel/opossum
// onto the same interceptor seam.

import type { RequestInterceptor } from "../core/interceptors.js";

export interface CircuitOptions {
  /** Consecutive failures before opening. Default 5. */
  threshold?: number;
  /** Cooldown before a half-open trial, ms. Default 10_000. */
  cooldownMs?: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  readonly code = -32002;
  constructor(server: string) {
    super(`circuit open for "${server}"`);
    this.name = "CircuitOpenError";
  }
}

export function circuitBreaker(opts: CircuitOptions = {}): RequestInterceptor {
  const threshold = opts.threshold ?? 5;
  const cooldown = opts.cooldownMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const state = new Map<string, { failures: number; openedAt?: number }>();

  return async (op, next) => {
    const s = state.get(op.server) ?? { failures: 0 };
    if (s.openedAt !== undefined) {
      if (now() - s.openedAt < cooldown) throw new CircuitOpenError(op.server);
      s.openedAt = undefined; // half-open: allow one trial through
    }
    try {
      const r = await next(op);
      state.set(op.server, { failures: 0 });
      return r;
    } catch (e) {
      const failures = s.failures + 1;
      state.set(op.server, { failures, openedAt: failures >= threshold ? now() : undefined });
      throw e;
    }
  };
}
