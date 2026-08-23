import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate, type GateConfig } from "../src/index.js";

async function gateWith(config: Omit<GateConfig, "audit"> & { audit?: GateConfig["audit"] }) {
  const gate = await createGate({ audit: () => {}, ...config });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(st);
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: {} });
  await consumer.connect(ct);
  return { gate, consumer, stop: async () => { await consumer.close(); await gate.close(); } };
}

const tool = (name: string, text: string, ann?: Record<string, boolean>) => ({
  name,
  annotations: ann,
  handler: () => ({ content: [{ type: "text", text }] }),
});

describe("mcp-gate", () => {
  it("fronts an upstream and routes namespaced calls", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] });
    const { consumer, stop } = await gateWith({ upstreams: { up: { transport: mock.transport } } });
    expect((await consumer.listTools()).tools.map((t) => t.name)).toEqual(["up.echo"]);
    const r = (await consumer.callTool({ name: "up.echo", arguments: { msg: "hi" } })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("hi");
    await stop();
  });

  it("enforces the declarative policy (denyDestructive + deny glob)", async () => {
    const mock = new MockMCPServer({
      tools: [tool("read_x", "ok", { readOnlyHint: true }), tool("delete_x", "gone", { destructiveHint: true }), tool("secret_op", "s")],
    });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      policy: { denyDestructive: true, deny: ["up.secret_*"] },
    });
    expect(((await consumer.callTool({ name: "up.read_x", arguments: {} })) as { content: { text: string }[] }).content[0]!.text).toBe("ok");
    await expect(consumer.callTool({ name: "up.delete_x", arguments: {} })).rejects.toBeTruthy(); // destructive
    await expect(consumer.callTool({ name: "up.secret_op", arguments: {} })).rejects.toBeTruthy(); // deny glob
    await stop();
  });

  it("hides name-denied tools from discovery (deny glob)", async () => {
    const mock = new MockMCPServer({ tools: [tool("read_x", "ok"), tool("secret_op", "s")] });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      policy: { deny: ["up.secret_*"] },
    });
    const names = (await consumer.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["up.read_x"]); // secret_op hidden from listing
    await stop();
  });

  it("redacts secrets in tool results before the agent sees them", async () => {
    const mock = new MockMCPServer({ tools: [tool("profile", "ssn 123-45-6789, mail a@b.com")] });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      redact: [{ pattern: /\d{3}-\d{2}-\d{4}/g, replacement: "[SSN]" }, { pattern: /\S+@\S+/g, replacement: "[EMAIL]" }],
    });
    const r = (await consumer.callTool({ name: "up.profile", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("ssn [SSN], mail [EMAIL]");
    await stop();
  });

  it("audits every call (incl. denials)", async () => {
    const audit = vi.fn();
    const mock = new MockMCPServer({ tools: [tool("danger", "x", { destructiveHint: true }), tool("ok", "y")] });
    const { consumer, stop } = await gateWith({ upstreams: { up: { transport: mock.transport } }, policy: { denyDestructive: true }, audit });
    await consumer.callTool({ name: "up.ok", arguments: {} });
    await consumer.callTool({ name: "up.danger", arguments: {} }).catch(() => {});
    const outcomes = audit.mock.calls.map((c) => [c[0].target, c[0].outcome]);
    expect(outcomes).toContainEqual(["ok", "ok"]);
    expect(outcomes).toContainEqual(["danger", "denied"]);
    await stop();
  });

  it("a throwing or rejecting audit callback doesn't crash the call (crash-safety wrapper)", async () => {
    const mock = new MockMCPServer({ tools: [tool("echo", "hi")] });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      audit: () => {
        throw new Error("audit sink down");
      },
    });
    const r = (await consumer.callTool({ name: "up.echo", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("hi"); // the call itself succeeds despite the audit sink throwing
    await stop();
  });

  it("an async audit callback's rejection is caught, not left unhandled", async () => {
    const mock = new MockMCPServer({ tools: [tool("echo", "hi")] });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      audit: async () => {
        throw new Error("async audit sink down");
      },
    });
    const r = (await consumer.callTool({ name: "up.echo", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("hi");
    await stop();
    // If the wrapper didn't catch the rejection, vitest would report an unhandled rejection
    // for this test — the absence of that failure is the assertion.
  });
});

describe("dynamic upstreams", () => {
  it("starts with zero upstreams and works", async () => {
    const { consumer, stop } = await gateWith({ upstreams: {} });
    expect((await consumer.listTools()).tools).toEqual([]);
    await stop();
  });

  it("addUpstream: a live-added server's tools appear without reconnecting", async () => {
    const { gate, consumer, stop } = await gateWith({ upstreams: {} });
    expect((await consumer.listTools()).tools).toEqual([]);
    const mock = new MockMCPServer({ tools: [tool("echo", "hi")] });
    await gate.addUpstream("up", { transport: mock.transport });
    expect((await consumer.listTools()).tools.map((t) => t.name)).toEqual(["up.echo"]);
    const r = (await consumer.callTool({ name: "up.echo", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("hi");
    await stop();
  });

  it("addUpstream rejects an already-existing name", async () => {
    const mock = new MockMCPServer({ tools: [] });
    const { gate, stop } = await gateWith({ upstreams: { up: { transport: mock.transport } } });
    await expect(gate.addUpstream("up", { transport: mock.transport })).rejects.toThrow();
    await stop();
  });

  it("addUpstream rejects a malformed spec, same validation as createGate", async () => {
    const { gate, stop } = await gateWith({ upstreams: {} });
    await expect(gate.addUpstream("bad", { command: "true", url: "https://example.com" } as never)).rejects.toThrow(
      /has both "command" and "url"/,
    );
    await stop();
  });

  it("removeUpstream: tool disappears from listing and calling it fails", async () => {
    const mock = new MockMCPServer({ tools: [tool("echo", "hi")] });
    const { gate, consumer, stop } = await gateWith({ upstreams: { up: { transport: mock.transport } } });
    expect((await consumer.listTools()).tools.map((t) => t.name)).toEqual(["up.echo"]);
    await gate.removeUpstream("up");
    expect((await consumer.listTools()).tools).toEqual([]);
    await expect(consumer.callTool({ name: "up.echo", arguments: {} })).rejects.toBeTruthy();
    await stop();
  });

  it("removeUpstream on an unknown name is a no-op", async () => {
    const { gate, stop } = await gateWith({ upstreams: {} });
    await expect(gate.removeUpstream("nope")).resolves.toBeUndefined();
    await stop();
  });

  it("updateUpstream swaps one upstream without disturbing another's connection", async () => {
    const mockA1 = new MockMCPServer({ tools: [tool("v1", "old")] });
    const mockB = new MockMCPServer({ tools: [tool("echo", "b-ok")] });
    const { gate, consumer, stop } = await gateWith({
      upstreams: { a: { transport: mockA1.transport }, b: { transport: mockB.transport } },
    });
    expect((await consumer.listTools()).tools.map((t) => t.name).sort()).toEqual(["a.v1", "b.echo"]);
    const mockA2 = new MockMCPServer({ tools: [tool("v2", "new")] });
    await gate.updateUpstream("a", { transport: mockA2.transport });
    expect((await consumer.listTools()).tools.map((t) => t.name).sort()).toEqual(["a.v2", "b.echo"]);
    const rb = (await consumer.callTool({ name: "b.echo", arguments: {} })) as { content: { text: string }[] };
    expect(rb.content[0]!.text).toBe("b-ok"); // b's connection was never touched by a's update
    await stop();
  });

  it("removing and re-adding a server resets its circuit breaker (state is pruned, not leaked)", async () => {
    const mock1 = new MockMCPServer({ tools: [{ name: "flaky", handler: () => { throw new Error("down"); } }] });
    const { gate, consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock1.transport } },
      circuitBreaker: { threshold: 1, cooldownMs: 100_000 },
    });
    await expect(consumer.callTool({ name: "up.flaky", arguments: {} })).rejects.toBeTruthy(); // 1 failure -> opens
    await expect(consumer.callTool({ name: "up.flaky", arguments: {} })).rejects.toBeTruthy(); // fast-failed while open
    await gate.removeUpstream("up");
    const mock2 = new MockMCPServer({ tools: [tool("flaky", "ok")] });
    await gate.addUpstream("up", { transport: mock2.transport });
    // If circuit/rate-limit state had leaked across the remove, this would still fast-fail
    // as "open" (cooldownMs is 100s, nowhere near elapsed) instead of reaching mock2.
    const r = (await consumer.callTool({ name: "up.flaky", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("ok");
    await stop();
  });
});

describe("multi-tenancy (partitionFrom)", () => {
  it("two partitions proceed concurrently under a per-server concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const { consumer, stop } = await gateWith({ upstreams: { up: { transport: mock.transport } }, rateLimit: { concurrency: 1 } });
    await Promise.all([
      consumer.callTool({ name: "up.slow", arguments: {}, _meta: { partition: "a" } }),
      consumer.callTool({ name: "up.slow", arguments: {}, _meta: { partition: "b" } }),
    ]);
    expect(peak).toBe(2); // NOT serialized to 1 — each partition gets its own concurrency budget
    await stop();
  });

  it("with no partition set anywhere, concurrency is capped globally per server (regression guard vs 0.0.3)", async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const { consumer, stop } = await gateWith({ upstreams: { up: { transport: mock.transport } }, rateLimit: { concurrency: 1 } });
    await Promise.all(Array.from({ length: 4 }, () => consumer.callTool({ name: "up.slow", arguments: {} })));
    expect(peak).toBe(1);
    await stop();
  });

  it("a circuit open for one partition doesn't affect another on the same upstream", async () => {
    let fail = true;
    const mock = new MockMCPServer({
      tools: [{ name: "flaky", handler: () => { if (fail) throw new Error("down"); return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      circuitBreaker: { threshold: 1, cooldownMs: 100_000 },
    });
    await expect(consumer.callTool({ name: "up.flaky", arguments: {}, _meta: { partition: "a" } })).rejects.toBeTruthy(); // a: opens
    fail = false; // upstream recovers, but "a"'s circuit stays open (cooldown far off)
    await expect(consumer.callTool({ name: "up.flaky", arguments: {}, _meta: { partition: "a" } })).rejects.toBeTruthy(); // still fast-failing
    const rb = (await consumer.callTool({ name: "up.flaky", arguments: {}, _meta: { partition: "b" } })) as { content: { text: string }[] };
    expect(rb.content[0]!.text).toBe("ok"); // "b" was never touched by "a"'s open circuit
    await stop();
  });

  it("a custom partitionFrom is honored", async () => {
    let active = 0;
    let peak = 0;
    const mock = new MockMCPServer({
      tools: [{ name: "slow", handler: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return { content: [{ type: "text", text: "ok" }] }; } }],
    });
    const { consumer, stop } = await gateWith({
      upstreams: { up: { transport: mock.transport } },
      rateLimit: { concurrency: 1 },
      partitionFrom: (meta) => (meta?.jwt as { tenantId?: string } | undefined)?.tenantId,
    });
    await Promise.all([
      consumer.callTool({ name: "up.slow", arguments: {}, _meta: { jwt: { tenantId: "x" } } }),
      consumer.callTool({ name: "up.slow", arguments: {}, _meta: { jwt: { tenantId: "y" } } }),
    ]);
    expect(peak).toBe(2);
    await stop();
  });
});
