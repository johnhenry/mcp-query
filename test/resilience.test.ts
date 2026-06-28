import { describe, it, expect } from "vitest";
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
      interceptors: [circuitBreaker({ threshold: 2, cooldownMs: 100, now: () => t })],
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
});

describe("rateLimit", () => {
  it("caps concurrency per server", async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [rateLimit({ concurrency: 2 })] });
    await client.connect();
    await Promise.all(Array.from({ length: 6 }, () => client.callTool("s.slow", {})));
    expect(peak).toBeLessThanOrEqual(2);
    await client.close();
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
