// #82 remainders through the gate: resources/read forwarding, and a 2025-era upstream's elicitation
// relayed to a consumer (redact, URL host policy, answerPolicy, audit).
import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallAuditEntry } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate, validateGateConfig, type GateConfig } from "../src/index.js";

vi.setConfig({ testTimeout: 60_000 });
type Ctx = { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> };
const text = (r: unknown) => (r as { content?: { text: string }[] }).content?.[0]?.text;
const form = { name: "ask", handler: async (_a: Record<string, unknown>, ctx: Ctx) => { const r = await ctx.elicit({ message: "Token for sk-SECRET123?", requestedSchema: { type: "object", properties: { token: { type: "string" } } } }); return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] }; } };
const link = (url: string) => ({ name: "link", handler: async (_a: Record<string, unknown>, ctx: Ctx) => { const r = await ctx.elicit({ mode: "url", message: "Sign in", url }); return { content: [{ type: "text", text: r.action }] }; } });

async function rig(config: Partial<GateConfig>, era: "legacy" | "modern", tools: unknown[] = [form], answer: Record<string, string> = { token: "abc" }) {
  const up = new MockMCPServer({
    tools: tools as never,
    resources: [{ uri: "file:///r", name: "r", read: async ({ elicit }) => { const r = await elicit({ message: "ok?", requestedSchema: { type: "object", properties: {} } }); return { text: `read ${r.action}` }; } }],
  });
  const audit: CallAuditEntry[] = [];
  const gate = await createGate({ audit: (e) => audit.push(e), ...config, upstreams: { up: { transport: up.transport, ...(era === "modern" ? { versions: ["2026-07-28"] } : {}) } as never } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(st);
  const asked: Array<Record<string, unknown>> = [];
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: { form: {}, url: {} } } });
  consumer.setRequestHandler("elicitation/create", async (req) => (asked.push(req.params as Record<string, unknown>), { action: "accept", content: answer }));
  await consumer.connect(ct);
  return { gate, consumer, asked, audit, stop: async () => { await consumer.close(); await gate.close(); await up.close(); } };
}

describe("gate: resources/read forwarding (modern upstream)", () => {
  it("redacts the forwarded request and audits both hops", async () => {
    const { consumer, asked, audit, stop } = await rig({ interactions: "forward", redact: [{ pattern: /sk-[A-Z0-9]+/g, replacement: "[KEY]" }] as never }, "modern", [form]);
    const r = (await consumer.readResource({ uri: "file:///r" })) as { contents: { text: string }[] };
    expect(r.contents[0]!.text).toBe("read accept");
    expect(asked).toHaveLength(1);
    expect(audit.filter((e) => e.kind === "read" && e.interaction).map((e) => e.interaction!.phase)).toEqual(["request", "response"]);
    await stop();
  });
  it("answerPolicy applies to a read's answer (denied: declined)", async () => {
    const { consumer, audit, stop } = await rig({ interactions: "forward", answerPolicy: { deny: ["up.file:///r"] } }, "modern");
    const r = (await consumer.readResource({ uri: "file:///r" })) as { contents: { text: string }[] };
    expect(r.contents[0]!.text).toBe("read decline");
    expect(audit.find((e) => e.interaction?.declined)).toBeTruthy();
    await stop();
  });
});

describe("gate: 2025-era upstream elicitation relayed", () => {
  it("forwards a form elicitation; redacts the request, scrubs the answer, audits both hops", async () => {
    const { consumer, asked, audit, stop } = await rig({ interactions: "forward", redact: [{ pattern: /sk-[A-Z0-9]+/g, replacement: "[KEY]" }, { pattern: /hunter2/g, replacement: "[PW]" }] as never }, "legacy", [form], { token: "hunter2" });
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe('accept:{"token":"[PW]"}');
    expect(asked[0]!.message).toBe("Token for [KEY]?");
    const hops = audit.filter((e) => e.interaction);
    expect(hops.map((e) => e.interaction!.phase)).toEqual(["request", "response"]);
    expect(hops[1]!.interaction!.redactedFields).toEqual(["elicitation-1.content.token"]);
    await stop();
  });
  it("URL-mode: a host outside allowHosts is refused (-32003 / error result) and the consumer is never shown it", async () => {
    const { consumer, asked, audit, stop } = await rig({ interactions: "forward", urlElicitation: { allowHosts: ["good.example.com"] } }, "legacy", [link("https://evil.test/x")]);
    const out = await consumer.callTool({ name: "up.link", arguments: {} }).catch((e) => ({ err: e }));
    expect(asked).toHaveLength(0);
    expect(JSON.stringify(out)).toMatch(/-32003/);
    expect(audit.some((e) => e.outcome === "denied" && e.interaction?.urlHosts?.includes("evil.test"))).toBe(true);
    await stop();
  });
  it("URL-mode: an allowed host is relayed", async () => {
    const { consumer, asked, stop } = await rig({ interactions: "forward", urlElicitation: { allowHosts: ["good.example.com"] } }, "legacy", [link("https://good.example.com/x")]);
    expect(text(await consumer.callTool({ name: "up.link", arguments: {} }))).toBe("accept");
    expect(asked[0]).toMatchObject({ mode: "url" });
    await stop();
  });
  it("answerPolicy denies an answer field: the upstream sees a decline", async () => {
    const { consumer, stop } = await rig({ interactions: "forward", answerPolicy: { denyFields: ["token"] } }, "legacy");
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe("decline:null");
    await stop();
  });
  it("without forward, a 2025-era upstream behaves as before (the consumer is not asked)", async () => {
    const { consumer, asked, stop } = await rig({}, "legacy");
    await consumer.callTool({ name: "up.ask", arguments: {} }).catch(() => {});
    expect(asked).toHaveLength(0);
    await stop();
  });
  it("validates interactionTimeoutMs", () => {
    expect(() => validateGateConfig({ upstreams: {}, interactionTimeoutMs: -1 })).toThrow(/interactionTimeoutMs/);
    expect(() => validateGateConfig({ upstreams: {}, interactionTimeoutMs: 1000 })).not.toThrow();
  });
});
