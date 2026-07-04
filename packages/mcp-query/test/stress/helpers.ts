// Shared helpers for the stress suite. Everything here is deterministic (seeded RNG) and
// hermetic by default; scenarios that need a real subprocess gate themselves on STRESS_REAL.

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const REAL = process.env.STRESS_REAL === "1";

/** Milliseconds budgets are ceilings to catch order-of-magnitude regressions, not benchmarks. */
export const BUDGET = {
  fanout1kMs: 2_000,
  parallel500P95Ms: 250,
  largeReadMs: 5_000,
  stormMs: 10_000,
};

export const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Deterministic RNG (mulberry32) so chaos scenarios replay identically. */
export function seededRng(seed = 0xc0ffee): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Transport factory for a real `server-everything` child (STRESS_REAL scenarios only). */
export function spawnEverything(): { transport: () => Transport; pids: () => number[] } {
  const transports: StdioClientTransport[] = [];
  return {
    transport: () => {
      const t = new StdioClientTransport({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });
      transports.push(t);
      return t;
    },
    pids: () => transports.map((t) => t.pid ?? -1).filter((p) => p > 0),
  };
}

export function percentiles(samples: number[]): { p50: number; p95: number; p99: number; max: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? 0 };
}

/** Force a full GC (vitest.stress.config passes --expose-gc) and return heapUsed. */
export async function heapAfterGc(): Promise<number> {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) throw new Error("run via vitest.stress.config.ts (--expose-gc missing)");
  // Two passes + a macrotask lets finalizers and transport buffers settle.
  g();
  await tick(20);
  g();
  return process.memoryUsage().heapUsed;
}

/** In-process RedisLike fake: two "clients" share a store; pub/sub is synchronous fan-out. */
export interface FakeRedisHub {
  makeClient(): {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode?: "PX" | "EX", ttl?: number): Promise<unknown>;
    del(key: string): Promise<unknown>;
    publish(channel: string, message: string): Promise<unknown>;
    subscribe(channel: string): Promise<unknown>;
    on(event: "message", listener: (channel: string, message: string) => void): unknown;
  };
  now(): number;
  advance(ms: number): void;
}

export function fakeRedisHub(): FakeRedisHub {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const subs: Array<{ channel: string; listener: (channel: string, message: string) => void }> = [];
  let clock = 0;
  const expired = (e: { expiresAt?: number }) => e.expiresAt !== undefined && e.expiresAt <= clock;
  return {
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    makeClient() {
      const listeners: Array<(channel: string, message: string) => void> = [];
      const channels = new Set<string>();
      return {
        async get(key) {
          const e = store.get(key);
          if (!e || expired(e)) return null;
          return e.value;
        },
        async set(key, value, mode, ttl) {
          const expiresAt = mode && ttl !== undefined ? clock + (mode === "EX" ? ttl * 1000 : ttl) : undefined;
          store.set(key, { value, expiresAt });
        },
        async del(key) {
          store.delete(key);
        },
        async publish(channel, message) {
          for (const s of subs) if (s.channel === channel) s.listener(channel, message);
        },
        async subscribe(channel) {
          channels.add(channel);
          for (const l of listeners) subs.push({ channel, listener: l });
        },
        on(_event, listener) {
          listeners.push(listener);
          for (const c of channels) subs.push({ channel: c, listener });
        },
      };
    },
  };
}
