// Interceptor failure injection: a 5-deep chain where one layer randomly throws or
// short-circuits across 500 calls. Failures must stay isolated per call, per-op state
// must never bleed between operations, the rate limiter's concurrency cap must hold
// under the storm, and the circuit breaker must open → fast-fail → half-open on schedule.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { RequestInterceptor } from "../../src/core/interceptors.js";
import { rateLimit } from "../../src/server/rateLimit.js";
import { circuitBreaker, CircuitOpenError } from "../../src/server/circuitBreaker.js";
import { x402Interceptor } from "../../src/server/x402Interceptor.js";
import { seededRng, tick } from "./helpers.js";

const CALLS = 500;

describe("interceptor chain under failure injection", () => {
  it("randomly throwing/short-circuiting layers stay isolated per call", async () => {
    const rng = seededRng(42);
    const stateBleed: string[] = [];

    const tagger: RequestInterceptor = async (op, next) => {
      // op.state must be fresh per operation — a residue from another call is a bleed.
      if (op.state.marker !== undefined) stateBleed.push(String(op.state.marker));
      op.state.marker = `${op.target}:${(op.args as { i?: number })?.i}`;
      return next(op);
    };
    const chaos: RequestInterceptor = async (op, next) => {
      const roll = rng();
      if (roll < 0.1) throw new Error(`chaos-throw ${(op.args as { i?: number })?.i}`);
      if (roll < 0.2) return { shortCircuited: true, i: (op.args as { i?: number })?.i };
      return next(op);
    };
    const observer: RequestInterceptor = async (op, next) => {
      const out = await next(op);
      return out;
    };

    const server = new MockMCPServer({
      tools: [{ name: "t", handler: (args) => ({ content: [{ type: "text", text: String(args.i) }] }) }],
    });
    const client = new MCPClient({
      servers: { s: { transport: server.transport } },
      interceptors: [
        tagger,
        observer,
        chaos,
        x402Interceptor({ enabled: true, gate: async () => "deny" }), // no 402 ever fires here — proves a configured-but-inert layer doesn't leak state or mask chaos's errors
        rateLimit({ concurrency: 16 }).interceptor,
        observer,
      ],
    });
    await client.connect();

    const settled = await Promise.allSettled(
      Array.from({ length: CALLS }, (_, i) => client.callTool("t", { i })),
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];

    expect(ok.length + failed.length).toBe(CALLS);
    expect(failed.length).toBeGreaterThan(0); // chaos actually fired
    for (const f of failed) expect(String(f.reason)).toContain("chaos-throw");
    expect(stateBleed).toEqual([]);

    await client.close();
  });

  it("rate limiter never exceeds its concurrency cap under a 500-call storm", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = new MockMCPServer({
      tools: [
        {
          name: "slow",
          handler: async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await tick(2);
            inFlight--;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ],
    });
    const client = new MCPClient({
      servers: { s: { transport: server.transport } },
      interceptors: [rateLimit({ concurrency: 4 }).interceptor],
    });
    await client.connect();

    await Promise.all(Array.from({ length: CALLS }, (_, i) => client.callTool("slow", { i })));
    expect(maxInFlight).toBeLessThanOrEqual(4);

    await client.close();
  });

  it("circuit breaker opens after threshold, fast-fails, then half-opens after cooldown", async () => {
    let now = 0;
    let healthy = false;
    let reached = 0;
    const server = new MockMCPServer({
      tools: [
        {
          name: "flaky",
          handler: () => {
            reached++;
            if (!healthy) throw new Error("upstream down");
            return { content: [{ type: "text", text: "up" }] };
          },
        },
      ],
    });
    const client = new MCPClient({
      servers: { s: { transport: server.transport } },
      interceptors: [circuitBreaker({ threshold: 3, cooldownMs: 1_000, now: () => now }).interceptor],
    });
    await client.connect();

    // Trip it: 3 consecutive failures.
    for (let i = 0; i < 3; i++) {
      await expect(client.callTool("flaky", { i })).rejects.toThrow("upstream down");
    }
    const reachedWhenOpen = reached;

    // Open: further calls fast-fail without touching the upstream.
    for (let i = 0; i < 25; i++) {
      await expect(client.callTool("flaky", { i })).rejects.toThrow(CircuitOpenError);
    }
    expect(reached).toBe(reachedWhenOpen);

    // Half-open after cooldown: the trial call goes through and closes the circuit.
    now += 1_001;
    healthy = true;
    const r = (await client.callTool("flaky", {})) as { content: Array<{ text: string }> };
    expect(r.content[0]?.text).toBe("up");
    expect(reached).toBe(reachedWhenOpen + 1);

    await client.close();
  });
});
