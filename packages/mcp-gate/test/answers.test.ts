// #100 — the ANSWER hop of a forwarded round: what the consumer typed is redacted and
// policy-checked before it goes upstream; requestState is never touched.
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallAuditEntry } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate, validateGateConfig, compileAnswerPolicy, redactTracked, type GateConfig } from "../src/index.js";

type Ctx = { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> };
const askForm = {
  name: "ask",
  handler: async (_a: Record<string, unknown>, ctx: Ctx) => {
    const r = await ctx.elicit({
      message: "Credentials",
      requestedSchema: { type: "object", properties: { user: { type: "string" }, secret: { type: "string" } } },
    });
    // What the UPSTREAM actually received, echoed back.
    return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] };
  },
};
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const TYPED = { user: "ada", secret: "sk-live-12345" };

async function rig(config: Partial<GateConfig>, typed: Record<string, unknown> = TYPED) {
  const up = new MockMCPServer({ tools: [askForm] as never });
  const audit: CallAuditEntry[] = [];
  const gate = await createGate({
    audit: (e) => audit.push(e),
    interactions: "forward",
    ...config,
    upstreams: { up: { transport: up.transport, versions: ["2026-07-28"] } as never },
  });
  // Record every call the gateway makes upstream (post-guard), and every round it returned.
  const upstreamCalls: Array<{ inputResponses?: Record<string, unknown>; requestState?: string }> = [];
  const rounds: Array<{ requestState?: string }> = [];
  const orig = gate.client.callTool.bind(gate.client);
  gate.client.callTool = (async (name: string, args: never, opts: { interaction?: never }) => {
    if (opts?.interaction) upstreamCalls.push(structuredClone(opts.interaction));
    const res = await orig(name, args, opts as never);
    if ((res as { resultType?: string })?.resultType === "input_required") rounds.push(res as never);
    return res;
  }) as never;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(st);
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  consumer.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: typed as never }));
  await consumer.connect(ct);
  return { gate, consumer, audit, upstreamCalls, rounds, stop: async () => { await consumer.close(); await gate.close(); await up.close(); } };
}

describe("answer redaction", () => {
  it("scrubs a secret typed into a form elicitation before the upstream sees it", async () => {
    const { consumer, upstreamCalls, stop } = await rig({ redact: [{ pattern: "sk-live-\\w+", replacement: "[KEY]" }] });
    const r = await consumer.callTool({ name: "up.ask", arguments: {} });
    // The upstream got the scrubbed answer...
    expect(text(r)).toBe('accept:{"user":"ada","secret":"[KEY]"}');
    expect(text(r)).not.toContain("sk-live");
    // ...on the wire the gateway sent, too.
    const answered = upstreamCalls.find((c) => c.inputResponses)!;
    expect(JSON.stringify(answered.inputResponses)).not.toContain("sk-live");
    expect(answered.inputResponses).toEqual({ q0: { action: "accept", content: { user: "ada", secret: "[KEY]" } } });
    await stop();
  });

  it("the answer hop's audit entry names the redacted fields and never their values", async () => {
    const { consumer, audit, stop } = await rig({ redact: [{ pattern: "sk-live-\\w+", replacement: "[KEY]" }] });
    await consumer.callTool({ name: "up.ask", arguments: {} });
    const hop = audit.find((e) => e.interaction?.phase === "response")!;
    expect(hop.interaction).toEqual({ phase: "response", redactedFields: ["q0.content.secret"] });
    expect(JSON.stringify(audit)).not.toContain("sk-live-12345");
    expect(JSON.stringify(audit)).not.toContain("[KEY]");
    await stop();
  });

  it("requestState is identical in and out, even under a rule that would corrupt it", async () => {
    // The mock's requestState token looks like "replay-1"; this rule would mangle it if applied.
    const { consumer, upstreamCalls, rounds, stop } = await rig({
      redact: [{ pattern: "replay", replacement: "XXXXXX" }, { pattern: "sk-live-\\w+", replacement: "[KEY]" }],
    });
    const r = await consumer.callTool({ name: "up.ask", arguments: {} });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.requestState).toMatch(/^replay-\d+$/);
    const retry = upstreamCalls.find((c) => c.inputResponses)!;
    expect(retry.requestState).toBe(rounds[0]!.requestState); // byte-for-byte
    expect(text(r)).toContain("[KEY]"); // the flow completed: upstream recognised its own token
    await stop();
  });
});

describe("answer policy", () => {
  it("deny turns the answer into a decline, and the audit says which key", async () => {
    const { consumer, audit, upstreamCalls, stop } = await rig({ answerPolicy: { denyFields: ["secret"] } });
    const r = await consumer.callTool({ name: "up.ask", arguments: {} });
    expect(text(r)).toBe("decline:null"); // the upstream was told the person declined
    expect(upstreamCalls.find((c) => c.inputResponses)!.inputResponses).toEqual({ q0: { action: "decline" } });
    const hop = audit.find((e) => e.interaction?.phase === "response")!;
    expect(hop.interaction).toEqual({ phase: "response", declined: ["q0"] });
    expect(JSON.stringify(audit)).not.toContain("sk-live");
    await stop();
  });

  it("a function policy sees kind 'answer' with field names, never values", async () => {
    const seen: unknown[] = [];
    const { consumer, stop } = await rig({ answerPolicy: (req) => (seen.push(req), "allow") });
    await consumer.callTool({ name: "up.ask", arguments: {} });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "answer", server: "up", target: "ask", answer: { surface: "tool", key: "q0", action: "accept", fields: ["user", "secret"] } });
    expect(JSON.stringify(seen)).not.toContain("sk-live");
    await stop();
  });

  it("approve: a human/handler 'allow' lets the answer through, 'deny' declines it", async () => {
    const approveSecret = { approveFields: ["secret"] };
    const yes = await rig({ answerPolicy: approveSecret, approval: { handler: () => "allow" } });
    expect(text(await yes.consumer.callTool({ name: "up.ask", arguments: {} }))).toBe(`accept:${JSON.stringify(TYPED)}`);
    await yes.stop();
    const no = await rig({ answerPolicy: approveSecret, approval: { handler: () => "deny" } });
    expect(text(await no.consumer.callTool({ name: "up.ask", arguments: {} }))).toBe("decline:null");
    expect(no.audit.find((e) => e.interaction?.phase === "response")!.interaction!.declined).toEqual(["q0"]);
    await no.stop();
  });

  it("a function policy returning approve with no approval backend fails closed (decline)", async () => {
    const { consumer, stop } = await rig({ answerPolicy: () => "approve" });
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe("decline:null");
    await stop();
  });

  it("a deny on a tool-id glob declines too, and an unrelated rule leaves the answer alone", async () => {
    const hit = await rig({ answerPolicy: { deny: ["up.ask"] } });
    expect(text(await hit.consumer.callTool({ name: "up.ask", arguments: {} }))).toBe("decline:null");
    await hit.stop();
    const miss = await rig({ answerPolicy: { deny: ["other.*"], denyFields: ["password"] } });
    expect(text(await miss.consumer.callTool({ name: "up.ask", arguments: {} }))).toBe(`accept:${JSON.stringify(TYPED)}`);
    await miss.stop();
  });
});

describe("default behaviour", () => {
  it("no redact, no answerPolicy: the answer goes upstream unchanged and the audit entry is the old shape", async () => {
    const { consumer, audit, upstreamCalls, stop } = await rig({});
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe(`accept:${JSON.stringify(TYPED)}`);
    expect(upstreamCalls.find((c) => c.inputResponses)!.inputResponses).toEqual({ q0: { action: "accept", content: TYPED } });
    expect(audit.filter((e) => e.interaction).map((e) => e.interaction)).toEqual([
      { phase: "request", methods: ["elicitation/create"] },
      { phase: "response" },
    ]);
    await stop();
  });

  it("redact rules with no answerPolicy: answers allowed (not declined), only scrubbed", async () => {
    const { consumer, stop } = await rig({ redact: [{ pattern: "ada", replacement: "[NAME]" }] });
    expect(text(await consumer.callTool({ name: "up.ask", arguments: {} }))).toBe('accept:{"user":"[NAME]","secret":"sk-live-12345"}');
    await stop();
  });
});

describe("units", () => {
  it("redactTracked reports paths, not values", () => {
    const r = redactTracked([{ pattern: "s3cret", replacement: "x" }], { a: { b: "s3cret", c: "fine" }, l: ["ok", "s3cret"] });
    expect(r.paths).toEqual(["a.b", "l[1]"]);
    expect(r.value).toEqual({ a: { b: "x", c: "fine" }, l: ["ok", "x"] });
  });
  it("compileAnswerPolicy: precedence deny > denyFields > approve > approveFields > allow", () => {
    const req = (fields: string[]) => ({ kind: "answer", server: "s", target: "t", destructive: false, readOnly: false, answer: { surface: "tool", key: "q0", action: "accept", fields } }) as never;
    const p = compileAnswerPolicy({ deny: ["s.bad"], denyFields: ["pw"], approve: ["s.t"], approveFields: ["ssn"] }, "s");
    expect(p(req(["pw"]))).toBe("deny");
    expect(p(req(["name"]))).toBe("approve"); // s.t matches `approve`
    expect(compileAnswerPolicy({ approveFields: ["ssn"] }, "s")(req(["person.ssn"]))).toBe("approve"); // last segment matches
    expect(compileAnswerPolicy(undefined, "s")(req(["pw"]))).toBe("allow");
  });
  it("validateGateConfig knows answerPolicy", () => {
    const base = { upstreams: { up: { url: "https://example.com/mcp" } } };
    expect(() => validateGateConfig({ ...base, answerPolicy: { denyFields: ["x"] } })).not.toThrow();
    expect(() => validateGateConfig({ ...base, answerPolicy: () => "allow" })).not.toThrow();
    expect(() => validateGateConfig({ ...base, answerPolicy: { denyField: ["x"] } })).toThrow(/unknown key "denyField"/);
    expect(() => validateGateConfig({ ...base, answerPolicy: { deny: "x" } })).toThrow(/array/);
    expect(() => validateGateConfig({ ...base, answerPolicy: { approveFields: ["x"] } })).toThrow(/approval/);
  });
});
