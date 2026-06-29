import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
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
});
