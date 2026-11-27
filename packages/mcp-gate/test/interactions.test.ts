// #82 slice 1 — forwarding an upstream's input_required (MRTR) round through the gate:
// policy, redaction, audit, URL-host policy, and the config validator.
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 }); // cold start of the first rig is slow on a loaded machine
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallAuditEntry } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate, validateGateConfig, compileUrlPolicy, type GateConfig } from "../src/index.js";

type Ctx = { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> };
const askForm = {
  name: "ask",
  handler: async (_a: Record<string, unknown>, ctx: Ctx) => {
    const r = await ctx.elicit({ message: "Pick a colour", requestedSchema: { type: "object", properties: { colour: { type: "string" } } } });
    return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] };
  },
};
const askUrl = (url: string) => ({
  name: "link",
  handler: async (_a: Record<string, unknown>, ctx: Ctx) => {
    const r = await ctx.elicit({ mode: "url", message: "Sign in", url });
    return { content: [{ type: "text", text: r.action }] };
  },
});
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

async function rig(config: Partial<GateConfig>, tools: unknown[] = [askForm]) {
  const up = new MockMCPServer({ tools: tools as never });
  const audit: CallAuditEntry[] = [];
  const gate = await createGate({
    audit: (e) => audit.push(e),
    ...config,
    upstreams: { up: { transport: up.transport, versions: ["2026-07-28"] } as never },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(st);
  const asked: Array<Record<string, unknown>> = [];
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: { form: {}, url: {} } } });
  consumer.setRequestHandler("elicitation/create", async (req) => (asked.push(req.params as Record<string, unknown>), { action: "accept", content: { colour: "green" } }));
  await consumer.connect(ct);
  return { gate, consumer, asked, audit, up, stop: async () => { await consumer.close(); await gate.close(); await up.close(); } };
}

describe("interactions: forward", () => {
  it("a consumer behind the gate answers an upstream form elicitation; the audit trail shows both hops", async () => {
    const { consumer, asked, audit, stop } = await rig({ interactions: "forward" });
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe('accept:{"colour":"green"}');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ message: "Pick a colour" });
    const hops = audit.filter((e) => e.interaction);
    expect(hops.map((e) => e.interaction!.phase)).toEqual(["request", "response"]);
    expect(hops[0]).toMatchObject({ server: "up", target: "ask", outcome: "ok", interaction: { methods: ["elicitation/create"] } });
    await stop();
  });

  it("redacts inputRequests but leaves requestState byte-for-byte (a rule that would corrupt it)", async () => {
    // /replay/ matches the upstream's requestState token ("replay-1"); /colour/ matches the question.
    const { consumer, asked, stop } = await rig({
      interactions: "forward",
      redact: [{ pattern: "colour", replacement: "[SECRET]" }, { pattern: "replay", replacement: "XXXXXX" }],
    });
    const r = await consumer.callTool({ name: "up.ask", arguments: {} });
    // The flow completed, so the upstream recognised its own (unredacted) token. The final
    // result is redacted too, hence the rewritten key.
    expect(text(r)).toBe('accept:{"[SECRET]":"green"}');
    expect(asked[0]!.message).toBe("Pick a [SECRET]");
    await stop();
  });

  it("per-upstream override via the config object", async () => {
    const { consumer, asked, stop } = await rig({ interactions: { default: "deny", upstreams: { up: "forward" } } });
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe('accept:{"colour":"green"}');
    expect(asked).toHaveLength(1);
    await stop();
  });
});

describe("interactions: deny and default", () => {
  it('"deny" refuses the round: the consumer is never asked and the call errors', async () => {
    const { consumer, asked, audit, stop } = await rig({ interactions: "deny" });
    await expect(consumer.callTool({ name: "up.ask", arguments: {} })).rejects.toBeTruthy();
    expect(asked).toHaveLength(0);
    expect(audit.at(-1)).toMatchObject({ target: "ask", outcome: "error" });
    await stop();
  });

  it("the default (answer) never shows the consumer an upstream elicitation", async () => {
    const { consumer, asked, stop } = await rig({});
    await consumer.callTool({ name: "up.ask", arguments: {} }).catch(() => {});
    expect(asked).toHaveLength(0);
    await stop();
  });
});

describe("interactions: URL-mode elicitation policy", () => {
  it("denies a URL host outside allowHosts, audits it as denied, and never asks the consumer", async () => {
    const { consumer, asked, audit, stop } = await rig(
      { interactions: "forward", urlElicitation: { allowHosts: ["*.good.example"] } },
      [askUrl("https://evil.example/login")],
    );
    await expect(consumer.callTool({ name: "up.link", arguments: {} })).rejects.toBeTruthy();
    expect(asked).toHaveLength(0);
    const last = audit.at(-1)!;
    expect(last.outcome).toBe("denied");
    expect(last.error).toContain("evil.example");
    await stop();
  });

  it("allows a URL host that matches allowHosts", async () => {
    const { consumer, asked, audit, stop } = await rig(
      { interactions: "forward", urlElicitation: { allowHosts: ["*.good.example"] } },
      [askUrl("https://auth.good.example/login")],
    );
    expect(text(await consumer.callTool({ name: "up.link", arguments: {} }))).toBe("accept");
    expect(asked[0]).toMatchObject({ mode: "url", url: "https://auth.good.example/login" });
    expect(audit.find((e) => e.interaction?.phase === "request")!.interaction!.urlHosts).toEqual(["auth.good.example"]);
    await stop();
  });

  it("fails closed with no allowHosts, and denyHosts beats allowHosts", async () => {
    const closed = await rig({ interactions: "forward" }, [askUrl("https://auth.good.example/x")]);
    await expect(closed.consumer.callTool({ name: "up.link", arguments: {} })).rejects.toBeTruthy();
    expect(closed.asked).toHaveLength(0);
    await closed.stop();

    const check = compileUrlPolicy({ allowHosts: ["*.good.example"], denyHosts: ["bad.good.example"] });
    expect(check("ok.good.example")).toEqual({ ok: true });
    expect(check("bad.good.example")).toMatchObject({ ok: false });
    expect(check("good.example")).toMatchObject({ ok: false }); // "*.good.example" needs a subdomain
    expect(check(undefined)).toMatchObject({ ok: false });
  });
});

describe("validateGateConfig: interactions + urlElicitation", () => {
  const base = { upstreams: { up: { url: "https://example.com/mcp" } } };
  it("accepts the documented shapes", () => {
    expect(() => validateGateConfig({ ...base, interactions: "forward", urlElicitation: { allowHosts: ["*.a.com"], denyHosts: ["x.a.com"] } })).not.toThrow();
    expect(() => validateGateConfig({ ...base, interactions: { default: "deny", upstreams: { up: "forward" } } })).not.toThrow();
  });
  it("rejects typos, bad modes and unknown upstream names", () => {
    expect(() => validateGateConfig({ ...base, interactions: "forwrad" })).toThrow(/interactions/);
    expect(() => validateGateConfig({ ...base, interactions: { defualt: "deny" } })).toThrow(/unknown key "defualt"/);
    expect(() => validateGateConfig({ ...base, interactions: { upstreams: { nope: "forward" } } })).toThrow(/"nope"/);
    expect(() => validateGateConfig({ ...base, urlElicitation: { allow: ["a"] } })).toThrow(/unknown key "allow"/);
    expect(() => validateGateConfig({ ...base, urlElicitation: { allowHosts: "a.com" } })).toThrow(/array/);
  });
});
