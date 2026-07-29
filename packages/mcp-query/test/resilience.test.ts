import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { circuitBreaker, CircuitOpenError } from "../src/server/circuitBreaker.js";
import { rateLimit } from "../src/server/rateLimit.js";
import { MetricsCollector } from "../src/metrics/index.js";

describe("circuitBreaker", () => {
  it("opens after the threshold, fails fast, then half-opens after cooldown", async () => {
    let t = 0;
    const mock = new MockMCPServer({ tools: [{ name: "flaky", handler: () => { throw new Error("down"); } }] });
    const client = new MCPClient({
      servers: { s: { transport: mock.transport } },
      interceptors: [circuitBreaker({ threshold: 2, cooldownMs: 100, now: () => t }).interceptor],
    });
    await client.connect();

    await client.callTool("s.flaky", {}).catch(() => {}); // fail 1
    await client.callTool("s.flaky", {}).catch(() => {}); // fail 2 -> open
    await expect(client.callTool("s.flaky", {})).rejects.toBeInstanceOf(CircuitOpenError); // fast-fail (server not hit)
    expect(mock.callLog).toHaveLength(2);

    t = 200; // past cooldown -> half-open, one trial reaches the server
    await client.callTool("s.flaky", {}).catch(() => {});
    expect(mock.callLog).toHaveLength(3);
    await client.close();
  });

  it("keyFn isolates breaker state: one key opening doesn't affect another on the same server", async () => {
    let fail = true;
    const mock = new MockMCPServer({
      tools: [{ name: "flaky", handler: () => { if (fail) throw new Error("down"); return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const client = new MCPClient({
      servers: { s: { transport: mock.transport } },
      interceptors: [circuitBreaker({ threshold: 1, cooldownMs: 100_000, keyFn: (op) => `${op.server}::${op.context?.partition ?? ""}` }).interceptor],
    });
    await client.connect();
    await expect(client.callTool("s.flaky", {}, { context: { partition: "a" } })).rejects.toBeTruthy(); // "a" opens
    fail = false;
    await expect(client.callTool("s.flaky", {}, { context: { partition: "a" } })).rejects.toBeInstanceOf(CircuitOpenError); // still open for "a"
    const r = (await client.callTool("s.flaky", {}, { context: { partition: "b" } })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("ok"); // "b" untouched
    await client.close();
  });

  it("dropServer prunes state for keys not prefixed by server (works for any keyFn)", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "flaky", handler: () => { throw new Error("down"); } }] });
    // Deliberately server-agnostic keyFn: the key doesn't encode op.server at all, so a
    // naive prefix-matching dropServer (string.startsWith(`${server}::`)) would fail here.
    const cb = circuitBreaker({ threshold: 1, cooldownMs: 100_000, keyFn: (op) => `${op.context?.partition ?? "default"}` });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [cb.interceptor] });
    await client.connect();
    await expect(client.callTool("s.flaky", {})).rejects.toBeTruthy(); // opens the "default" key
    await expect(client.callTool("s.flaky", {})).rejects.toBeInstanceOf(CircuitOpenError); // confirmed open
    cb.dropServer("s");
    // If state weren't pruned, this would still fast-fail as open (cooldown is 100s).
    await expect(client.callTool("s.flaky", {})).rejects.not.toBeInstanceOf(CircuitOpenError);
    await client.close();
  });
});

describe("rateLimit", () => {
  it("caps concurrency per server", async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [rateLimit({ concurrency: 2 }).interceptor] });
    await client.connect();
    await Promise.all(Array.from({ length: 6 }, () => client.callTool("s.slow", {})));
    expect(peak).toBeLessThanOrEqual(2);
    await client.close();
  });

  it("keyFn isolates concurrency budgets: two keys run past the per-key cap", async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const client = new MCPClient({
      servers: { s: { transport: mock.transport } },
      interceptors: [rateLimit({ concurrency: 1, keyFn: (op) => `${op.server}::${op.context?.partition ?? ""}` }).interceptor],
    });
    await client.connect();
    await Promise.all([
      client.callTool("s.slow", {}, { context: { partition: "a" } }),
      client.callTool("s.slow", {}, { context: { partition: "b" } }),
    ]);
    expect(peak).toBe(2); // not serialized to 1 — each key has its own budget
    await client.close();
  });
});

describe("onCall", () => {
  async function withoutUnhandledRejection(run: () => Promise<void>): Promise<void> {
    let caught: unknown;
    const onUnhandled = (e: unknown) => { caught = e; };
    process.on("unhandledRejection", onUnhandled);
    try {
      await run();
      // Give a microtask/macrotask turn for a rejection produced during `run()` to surface.
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    if (caught !== undefined) throw new Error(`unhandled rejection: ${String(caught)}`);
  }

  it("an async onCall's rejection doesn't propagate to the caller or go unhandled", async () => {
    await withoutUnhandledRejection(async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mock = new MockMCPServer({ tools: [{ name: "echo", handler: () => ({ content: [{ type: "text", text: "hi" }] }) }] });
      const client = new MCPClient({
        servers: { s: { transport: mock.transport } },
        onCall: async () => { throw new Error("audit sink down"); },
      });
      await client.connect();
      const r = (await client.callTool("s.echo", {})) as { content: { text: string }[] };
      expect(r.content[0]!.text).toBe("hi"); // the call itself succeeds
      await client.close();
      expect(errSpy).toHaveBeenCalledWith("[mcp-query] onCall rejected:", expect.any(Error));
      errSpy.mockRestore();
    });
  });

  it("a sync onCall that throws doesn't propagate to the caller", async () => {
    await withoutUnhandledRejection(async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const mock = new MockMCPServer({ tools: [{ name: "echo", handler: () => ({ content: [{ type: "text", text: "hi" }] }) }] });
      const client = new MCPClient({
        servers: { s: { transport: mock.transport } },
        onCall: () => { throw new Error("audit sink down"); },
      });
      await client.connect();
      const r = (await client.callTool("s.echo", {})) as { content: { text: string }[] };
      expect(r.content[0]!.text).toBe("hi");
      await client.close();
      expect(errSpy).toHaveBeenCalledWith("[mcp-query] onCall threw:", expect.any(Error));
      errSpy.mockRestore();
    });
  });

  it("a plain sync onCall is unaffected (regression)", async () => {
    const entries: unknown[] = [];
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: () => ({ content: [{ type: "text", text: "hi" }] }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, onCall: (e) => { entries.push(e); } });
    await client.connect();
    await client.callTool("s.echo", {});
    await client.close();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "ok", target: "echo" });
  });
});

describe("MetricsCollector", () => {
  it("records counts/errors/latency and exports Prometheus text", async () => {
    let t = 0;
    const metrics = new MetricsCollector({ now: () => (t += 5) });
    const mock = new MockMCPServer({
      tools: [{ name: "ok", handler: () => ({ content: [{ type: "text", text: "y" }] }) }, { name: "boom", handler: () => { throw new Error("x"); } }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [metrics.interceptor()] });
    await client.connect();

    await client.callTool("s.ok", {});
    await client.callTool("s.boom", {}).catch(() => {});

    const snap = metrics.snapshot().find((m) => m.kind === "call")!;
    expect(snap.count).toBe(2);
    expect(snap.errors).toBe(1);
    const prom = metrics.prometheus();
    expect(prom).toContain('mcpquery_requests_total{server="s",op="call"} 2');
    expect(prom).toContain("mcpquery_request_duration_ms_bucket");
    await client.close();
  });
});
