import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { InteractionBroker } from "@johnhenry/mcp-query";
import { createGate, type GateConfig } from "../src/index.js";

const tool = (name: string, text: string, ann?: Record<string, boolean>) => ({
  name,
  annotations: ann,
  handler: () => ({ content: [{ type: "text", text }] }),
});

async function gateWith(config: Omit<GateConfig, "audit" | "upstreams">) {
  const ran: string[] = [];
  const mock = new MockMCPServer({
    tools: [
      { ...tool("read_x", "read"), handler: () => (ran.push("read_x"), { content: [{ type: "text", text: "read" }] }) },
      { ...tool("write_x", "wrote"), handler: () => (ran.push("write_x"), { content: [{ type: "text", text: "wrote" }] }) },
      { ...tool("rm_x", "gone", { destructiveHint: true }), handler: () => (ran.push("rm_x"), { content: [{ type: "text", text: "gone" }] }) },
    ],
  });
  const audit = vi.fn();
  const gate = await createGate({ upstreams: { up: { transport: mock.transport } }, audit, ...config });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(st);
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: {} });
  await consumer.connect(ct);
  const call = (name: string) => consumer.callTool({ name: `up.${name}`, arguments: {} }) as Promise<{ content: { text: string }[] }>;
  return { gate, call, ran, audit, stop: async () => { await consumer.close(); await gate.close(); } };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("gate approval", () => {
  it("non-approve calls never reach the approver", async () => {
    const handler = vi.fn(() => "allow" as const);
    const { call, stop } = await gateWith({ policy: { approve: ["up.write_*"] }, approval: { handler } });
    expect((await call("read_x")).content[0]!.text).toBe("read");
    expect(handler).not.toHaveBeenCalled();
    await stop();
  });

  it("handler allow -> upstream runs; handler deny -> -32003, upstream untouched", async () => {
    let answer: "allow" | "deny" = "allow";
    const handler = vi.fn(async () => answer);
    const { call, ran, audit, stop } = await gateWith({ policy: { approve: ["up.write_*"] }, approval: { handler } });
    expect((await call("write_x")).content[0]!.text).toBe("wrote");
    answer = "deny";
    await expect(call("write_x")).rejects.toThrow(/not approved/);
    expect(ran).toEqual(["write_x"]);
    const req = (handler.mock.calls[0] as unknown as [{ server: string; target: string; kind: string }])[0];
    expect(req).toMatchObject({ server: "up", target: "write_x", kind: "call" });
    await tick();
    expect(audit.mock.calls.map((c) => c[0].outcome)).toContain("denied");
    await stop();
  });

  it("a throwing handler denies (fail closed)", async () => {
    const { call, ran, stop } = await gateWith({ policy: { approve: ["up.*"] }, approval: { handler: () => { throw new Error("boom"); } } });
    await expect(call("write_x")).rejects.toThrow(/boom/);
    expect(ran).toEqual([]);
    await stop();
  });

  it("without a handler, the call parks in gate.approvals until a human resolves it", async () => {
    const { gate, call, ran, stop } = await gateWith({ policy: { approve: ["up.write_*"] }, approval: {} });
    const p = call("write_x");
    await tick();
    expect(ran).toEqual([]);
    const [pending] = gate.approvals!.list();
    expect(pending!.payload).toMatchObject({ tool: "write_x", destructive: false });
    gate.approvals!.resolve(pending!.id, { action: "approve" });
    expect((await p).content[0]!.text).toBe("wrote");

    const p2 = call("write_x");
    await tick();
    gate.approvals!.resolve(gate.approvals!.list()[0]!.id, { action: "deny", reason: "too risky" });
    await expect(p2).rejects.toThrow(/too risky/);
    expect(ran).toEqual(["write_x"]);
    await stop();
  });

  it("timeoutMs with no decision denies and clears the queue", async () => {
    const { gate, call, ran, stop } = await gateWith({ policy: { approve: ["up.*"] }, approval: { timeoutMs: 40, onTimeout: "deny" } });
    await expect(call("write_x")).rejects.toThrow(/not approved/);
    expect(ran).toEqual([]);
    expect(gate.approvals!.list()).toEqual([]);
    await stop();
  });

  it("a function policy can return 'approve' (destructive tools to a human)", async () => {
    const handler = vi.fn(() => "allow" as const);
    const { call, ran, stop } = await gateWith({
      policy: (req) => (req.destructive ? "approve" : "allow"),
      approval: { handler },
    });
    await call("read_x");
    expect(handler).not.toHaveBeenCalled();
    await call("rm_x");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(["read_x", "rm_x"]);
    await stop();
  });

  it("a function policy returning 'approve' with no approval config is denied", async () => {
    const { call, ran, stop } = await gateWith({ policy: () => "approve" });
    await expect(call("write_x")).rejects.toThrow(/requires approval but no approver/);
    expect(ran).toEqual([]);
    await stop();
  });

  it("honors a supplied broker's own policy (auto-allow / auto-deny without a human)", async () => {
    const broker = new InteractionBroker({ policy: (ctx) => ((ctx.payload as { tool: string }).tool === "rm_x" ? "deny" : "allow") });
    const { call, ran, stop } = await gateWith({ policy: { approve: ["up.*"] }, approval: { broker } });
    expect((await call("write_x")).content[0]!.text).toBe("wrote");
    await expect(call("rm_x")).rejects.toThrow(/not approved/);
    expect(ran).toEqual(["write_x"]);
    await stop();
  });

  it("denyDestructive wins over approve; a denied call never reaches the approver", async () => {
    const handler = vi.fn(() => "allow" as const);
    const { call, ran, stop } = await gateWith({ policy: { approve: ["up.*"], denyDestructive: true }, approval: { handler } });
    await expect(call("rm_x")).rejects.toThrow(/denied/);
    expect(handler).not.toHaveBeenCalled();
    expect(ran).toEqual([]);
    await stop();
  });

  describe("approval.discovery", () => {
    const names = async (consumer: Awaited<ReturnType<typeof gateWithConsumer>>["consumer"]) =>
      (await consumer.listTools()).tools.map((t) => t.name).sort();
    async function gateWithConsumer(config: Parameters<typeof gateWith>[0]) {
      const g = await gateWith(config);
      // gateWith doesn't expose its consumer; open a second one for listings.
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await g.gate.server.connect(st);
      const consumer = new Client({ name: "c2", version: "1" }, { capabilities: {} });
      await consumer.connect(ct);
      // A Server holds one transport: the second connect supersedes gateWith's own consumer,
      // so route calls through this consumer too.
      const call = (name: string) => consumer.callTool({ name: `up.${name}`, arguments: {} }) as Promise<{ content: { text: string }[] }>;
      return { ...g, consumer, call };
    }

    it("defaults to 'visible': approve-listed tools are listed, unmarked", async () => {
      const { consumer, stop } = await gateWithConsumer({ policy: { approve: ["up.write_*"] }, approval: { handler: () => "allow" } });
      const tools = (await consumer.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["up.read_x", "up.rm_x", "up.write_x"]);
      expect(tools.find((t) => t.name === "up.write_x")!._meta?.requiresApproval).toBeUndefined();
      await stop();
    });

    it("'visible' (explicit) behaves like the default", async () => {
      const { consumer, stop } = await gateWithConsumer({ policy: { approve: ["up.write_*"] }, approval: { handler: () => "allow", discovery: "visible" } });
      expect(await names(consumer)).toEqual(["up.read_x", "up.rm_x", "up.write_x"]);
      await stop();
    });

    it("'annotated' lists every tool and flags only approve-listed ones with _meta.requiresApproval", async () => {
      const { consumer, stop } = await gateWithConsumer({ policy: { approve: ["up.write_*"] }, approval: { handler: () => "allow", discovery: "annotated" } });
      const tools = (await consumer.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["up.read_x", "up.rm_x", "up.write_x"]);
      expect(tools.find((t) => t.name === "up.write_x")!._meta?.requiresApproval).toBe(true);
      expect(tools.find((t) => t.name === "up.read_x")!._meta?.requiresApproval).toBeUndefined();
      await stop();
    });

    it("'hidden' omits approve-listed tools from tools/list but a direct call still goes through approval", async () => {
      const handler = vi.fn(() => "allow" as const);
      const { consumer, call, ran, stop } = await gateWithConsumer({ policy: { approve: ["up.write_*"] }, approval: { handler, discovery: "hidden" } });
      expect(await names(consumer)).toEqual(["up.read_x", "up.rm_x"]);
      expect((await call("write_x")).content[0]!.text).toBe("wrote");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(ran).toEqual(["write_x"]);
      await stop();
    });

    it("'hidden' + denying handler: the hidden tool is still refused", async () => {
      const { call, ran, stop } = await gateWithConsumer({ policy: { approve: ["up.write_*"] }, approval: { handler: () => "deny", discovery: "hidden" } });
      await expect(call("write_x")).rejects.toThrow(/not approved/);
      expect(ran).toEqual([]);
      await stop();
    });

    it("combines with allow/deny: name-denied stay hidden in every mode", async () => {
      const { consumer, stop } = await gateWithConsumer({ policy: { deny: ["up.rm_*"], approve: ["up.write_*"] }, approval: { handler: () => "allow", discovery: "annotated" } });
      expect(await names(consumer)).toEqual(["up.read_x", "up.write_x"]);
      await stop();
    });

    it("rejects an unknown discovery value at config validation", async () => {
      await expect(
        createGate({ upstreams: { up: { transport: new MockMCPServer({ tools: [] }).transport } }, policy: { approve: ["up.*"] }, approval: { handler: () => "allow", discovery: "nope" as never } }),
      ).rejects.toThrow(/discovery/);
    });
  });
});
