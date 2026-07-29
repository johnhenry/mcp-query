// Tenant-aware circuit breaker — a fork of @johnhenry/mcpq/server's circuitBreaker(), keyed
// by `${server}::${partition}` instead of `server` alone, so one tenant hammering a failing
// upstream doesn't trip the breaker for every other tenant sharing the same gate. See
// rateLimit.ts's header comment for why this is a fork rather than an mcpq change, and why
// the default (no partition set) behavior is unchanged.

import type { Operation, RequestInterceptor } from "@johnhenry/mcpq";

export interface CircuitOptions {
  /** Consecutive failures before opening, per (server, tenant) pair. Default 5. */
  threshold?: number;
  /** Cooldown before a half-open trial, ms. Default 10_000. */
  cooldownMs?: number;
  now?: () => number;
}

export interface TenantCircuitBreaker {
  interceptor: RequestInterceptor;
  /** Drop all state for a removed upstream (called by Gate.removeUpstream). */
  dropServer(server: string): void;
}

/** Thrown when the breaker is open for an (server, tenant) pair. Code -32002, matching mcpq/server's CircuitOpenError. */
export class CircuitOpenError extends Error {
  readonly code = -32002;
  constructor(server: string, partition?: string) {
    super(partition ? `circuit open for "${server}" (tenant "${partition}")` : `circuit open for "${server}"`);
    this.name = "CircuitOpenError";
  }
}

const key = (op: Operation) => `${op.server}::${op.context?.partition ?? ""}`;

export function circuitBreaker(opts: CircuitOptions = {}): TenantCircuitBreaker {
  const threshold = opts.threshold ?? 5;
  const cooldown = opts.cooldownMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const state = new Map<string, { failures: number; openedAt?: number }>();

  return {
    interceptor: async (op, next) => {
      const k = key(op);
      const s = state.get(k) ?? { failures: 0 };
      if (s.openedAt !== undefined) {
        if (now() - s.openedAt < cooldown) throw new CircuitOpenError(op.server, op.context?.partition);
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
      const prefix = `${server}::`;
      for (const k of [...state.keys()]) if (k.startsWith(prefix)) state.delete(k);
    },
  };
}
