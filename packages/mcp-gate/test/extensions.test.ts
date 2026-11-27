// #82 items 3, 4, 5 at the gate: tasks (redaction, URL policy, answer guard, tenancy), skills
// (policy only, never redaction) and MCP Apps negotiation. Legacy wires + an injected skills SDK:
// runs on SDK 2.0.0 and newer.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import * as z from "zod";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MCPClient, type CallAuditEntry } from "@johnhenry/mcp-query";
import { UI_EXT } from "@johnhenry/mcp-query/server";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { compilePolicy, explainPolicy, createGate, policySkillFilter, validateGateConfig, type GateConfig } from "../src/index.js";

const TASKS = "io.modelcontextprotocol/tasks";
const SKILLS = "io.modelcontextprotocol/skills";
const loose = z.looseObject({});
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
});

type Ctx = { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> };
const taskTools = [
  { name: "report", task: true, taskDelayMs: 20, handler: () => ({ content: [{ type: "text", text: "key sk-live-999 for task-77" }] }) },
  {
    name: "ask",
    task: true,
    taskDelayMs: 5,
    handler: async (_a: Record<string, unknown>, ctx: Ctx) => {
      const r = await ctx.elicit({ message: "Enter the key (sk-live-abc)", requestedSchema: { type: "object", properties: { user: { type: "string" }, secret: { type: "string" } } } });
      return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] };
    },
  },
  {
    name: "login",
    task: true,
    taskDelayMs: 5,
    handler: async (_a: Record<string, unknown>, ctx: Ctx) => {
      const r = await ctx.elicit({ mode: "url", message: "Sign in", url: "https://evil.example/oauth" });
      return { content: [{ type: "text", text: r.action }] };
    },
  },
];

async function rig(config: Partial<GateConfig> = {}, declare: Record<string, object> = { [TASKS]: {} }) {
  const up = new MockMCPServer({ tools: taskTools as never }, { era: "legacy" });
  const audit: CallAuditEntry[] = [];
  const gate = await createGate({ audit: (e) => audit.push(e), ...config, upstreams: { up: { transport: up.transport } } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(st);
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: { extensions: declare } as never });
  await consumer.connect(ct);
  closers.push(async () => { await consumer.close(); await gate.close(); await up.close(); });
  const req = (method: string, params: Record<string, unknown>) => consumer.request({ method, params } as never, loose as never) as Promise<Record<string, any>>;
  const until = async (id: string, status: string, meta?: Record<string, unknown>) => {
    let t: Record<string, any> = {};
    for (let i = 0; i < 200 && t.status !== status; i++) {
      t = await req("tasks/get", { taskId: id, ...(meta ? { _meta: meta } : {}) });
      if (t.status !== status) await sleep(10);
    }
    return t;
  };
  return { gate, consumer, audit, up, req, until };
}

describe("tasks at the gate", () => {
  it("redacts the inlined result of a completed task, never the ids that route it", async () => {
    const { req, until } = await rig({ redact: [{ pattern: "sk-live-\\w+", replacement: "[KEY]" }, { pattern: "task-\\d+", replacement: "[TASK]" }] });
    const created = await req("tools/call", { name: "up.report", arguments: {} });
    expect(created.taskId).toMatch(/^gw1\./); // the handle was not scrubbed (and upstream's "task-1" is still routable)
    const done = await until(String(created.taskId), "completed");
    expect(done.status).toBe("completed");
    expect(text(done.result)).toBe("key [KEY] for [TASK]");
    expect(done.taskId).toBe(created.taskId);
  });

  it("redacts the inputRequests of a task waiting for input, and the answer on the way back (answer guard)", async () => {
    const audit: CallAuditEntry[] = [];
    const { req, until } = await rig({
      audit: (e) => audit.push(e),
      redact: [{ pattern: "sk-live-\\w+", replacement: "[KEY]" }],
      answerPolicy: { denyFields: ["user"] },
    });
    const id = String((await req("tools/call", { name: "up.ask", arguments: {} })).taskId);
    const waiting = await until(id, "input_required");
    expect(waiting.inputRequests.q0.params.message).toBe("Enter the key ([KEY])");
    await req("tasks/update", { taskId: id, inputResponses: { q0: { action: "accept", content: { user: "ada", secret: "sk-live-12345" } } } });
    // The answer policy declined a form that asked for `user`; had it been allowed, redact would have scrubbed the key.
    const done = await until(id, "completed");
    expect(text(done.result)).toBe("decline:null");
    expect(audit.find((e) => e.kind === "task" && e.interaction?.phase === "response")?.interaction).toMatchObject({ phase: "response", declined: ["q0"] });
    expect(JSON.stringify(audit)).not.toContain("sk-live-12345");
  });

  it("scrubs an allowed answer to a task before it goes upstream", async () => {
    const { req, until } = await rig({ redact: [{ pattern: "sk-live-\\w+", replacement: "[KEY]" }] });
    const id = String((await req("tools/call", { name: "up.ask", arguments: {} })).taskId);
    await until(id, "input_required");
    await req("tasks/update", { taskId: id, inputResponses: { q0: { action: "accept", content: { user: "ada", secret: "sk-live-12345" } } } });
    const done = await until(id, "completed");
    expect(text(done.result)).toBe('accept:{"user":"ada","secret":"[KEY]"}');
  });

  it("a URL-mode elicitation inside a task obeys urlElicitation host policy", async () => {
    const closed = await rig({});
    const id = String((await closed.req("tools/call", { name: "up.login", arguments: {} })).taskId);
    await sleep(40);
    // Fails closed with no allowHosts: the consumer is never sent to the upstream-chosen URL.
    await expect(closed.req("tasks/get", { taskId: id })).rejects.toMatchObject({ code: -32003 });
    expect(closed.audit.some((e) => e.kind === "task" && e.outcome === "denied")).toBe(true);

    const open = await rig({ urlElicitation: { allowHosts: ["evil.example"] } });
    const id2 = String((await open.req("tools/call", { name: "up.login", arguments: {} })).taskId);
    const t = await open.until(id2, "input_required");
    expect(t.inputRequests.q0.params.url).toBe("https://evil.example/oauth");
    expect(open.audit.find((e) => e.kind === "task" && e.interaction?.phase === "request")?.interaction).toMatchObject({ methods: ["elicitation/create"], urlHosts: ["evil.example"] });
  });

  it("tenants are isolated by the gate's partitionFrom; a policy that denies the tool denies its polls", async () => {
    const { req } = await rig({ partitionFrom: (meta) => (meta?.tenant as string | undefined) });
    const id = String((await req("tools/call", { name: "up.report", arguments: {}, _meta: { tenant: "t1" } })).taskId);
    await expect(req("tasks/get", { taskId: id, _meta: { tenant: "t2" } })).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    await expect(req("tasks/cancel", { taskId: id, _meta: { tenant: "t2" } })).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    expect((await req("tasks/get", { taskId: id, _meta: { tenant: "t1" } })).taskId).toBe(id);

    let denyPolls = false;
    const gated = await rig({ policy: (r) => (denyPolls && r.kind === "task" ? "deny" : "allow") });
    const id2 = String((await gated.req("tools/call", { name: "up.report", arguments: {} })).taskId);
    denyPolls = true;
    await expect(gated.req("tasks/get", { taskId: id2 })).rejects.toMatchObject({ code: -32003 });
  });

  it("declarative policy: a denied tool cannot be polled either, and approval is asked at creation, not per poll", async () => {
    const p = compilePolicy({ deny: ["up.report"], approve: ["up.ask"] });
    const base = { server: "up", destructive: false, readOnly: false, kind: "task" as const };
    expect(p({ ...base, target: "report" })).toBe("deny");
    expect(p({ ...base, target: "ask" })).toBe("allow");
    expect(p({ ...base, kind: "call" as never, target: "ask" })).toBe("approve");
    expect(p({ ...base, kind: "extension" as never, target: "events/poll" })).toBe("allow");
  });

  it("tasks are not offered to a consumer that did not declare them, and denied tasks stay out", async () => {
    const { consumer, req } = await rig({}, {});
    expect(consumer.getServerCapabilities()?.extensions).toBeUndefined();
    expect(text(await req("tools/call", { name: "up.report", arguments: {} }).then((r) => ({ content: r.content })))).toContain("sk-live-999");
    const denied = await rig({ extensions: { deny: [TASKS] } });
    expect(denied.consumer.getServerCapabilities()?.extensions).toBeUndefined();
  });
});

// ── skills ──────────────────────────────────────────────────────────────────────

const sha256 = async (b: Uint8Array) => "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as never))].map((x) => x.toString(16).padStart(2, "0")).join("");
function wireSkillsSdk() {
  class SkillsClient {
    constructor(private readonly raw: Client) {}
    list() { return this.raw.request({ method: "skills/list", params: {} } as never, z.looseObject({ skills: z.array(z.any()) }) as never); }
    get(uri: string) { return this.raw.request({ method: "skills/get", params: { uri } } as never, z.looseObject({ skill: z.any() }) as never); }
    async read(skill: { uri: string; resources: Array<{ uri: string; digest: string; size: number }> | "dynamic" }, ref?: string) {
      const root = skill.uri.slice(0, skill.uri.lastIndexOf("/") + 1);
      const uri = ref === undefined ? skill.uri : /^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : root + ref;
      const c = (await this.raw.readResource({ uri })).contents[0] as { text?: string };
      const bytes = new TextEncoder().encode(c.text ?? "");
      const entry = skill.resources === "dynamic" ? undefined : skill.resources.find((r) => r.uri === uri);
      if (!entry || entry.size !== bytes.length || entry.digest !== (await sha256(bytes))) throw Object.assign(new Error("skill verification failed"), { name: "SkillVerificationError", reason: "digest", uri });
      return { uri, bytes, text: c.text, verified: true };
    }
  }
  return async () => ({ SkillsClient }) as never;
}

describe("skills at the gate", () => {
  async function skillRig(config: Partial<GateConfig> = {}) {
    const a = new MockMCPServer({ skills: [{ name: "deploy", description: "Deploy", body: "Mail ops@example.com and use sk-live-12345\n", files: { "references/KEYS.md": "token sk-live-67890\n" } }, { name: "secret-sauce", description: "Internal" }] }, { era: "legacy" });
    const b = new MockMCPServer({ skills: [{ name: "deploy", description: "B deploy" }] }, { era: "legacy" });
    const audit: CallAuditEntry[] = [];
    const gate = await createGate({ audit: (e) => audit.push(e), ...config, upstreams: { a: { transport: a.transport }, b: { transport: b.transport } } });
    (gate.client as unknown as { skills: { host: { loader: unknown } } }).skills.host.loader = wireSkillsSdk();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gate.server.connect(st);
    const consumer = new MCPClient({ servers: { gw: { transport: () => ct } }, skillsSdk: wireSkillsSdk(), extensions: { [SKILLS]: {} } });
    await consumer.connect();
    closers.push(async () => { await consumer.close(); await gate.close(); await a.close(); await b.close(); });
    return { gate, consumer, audit };
  }

  it("redact rules never touch a skill: the bytes verify at the consumer, digests unchanged", async () => {
    const { consumer, gate } = await skillRig({ redact: [{ pattern: "sk-live-\\w+", replacement: "[KEY]" }, { pattern: "[\\w.]+@[\\w.]+", replacement: "[EMAIL]" }] });
    const skills = await consumer.listSkills("gw");
    expect(skills.map((s) => s.uri).sort()).toEqual(["skill://a/deploy/SKILL.md", "skill://a/secret-sauce/SKILL.md", "skill://b/deploy/SKILL.md"]);
    const deploy = skills.find((s) => s.uri === "skill://a/deploy/SKILL.md")!;
    const md = await consumer.readSkillFile(deploy);
    expect(md.verified).toBe(true);
    expect(md.text).toContain("sk-live-12345"); // an owner decision: skill files are not rewritten (it would break the digest)
    expect(md.text).toContain("ops@example.com");
    expect((await consumer.readSkillFile(deploy, "references/KEYS.md")).text).toContain("sk-live-67890");
    // The same file read at the gate's own client: also untouched and verified.
    const direct = await gate.client.listSkills("a");
    const f = await gate.client.readSkillFile(direct.find((s) => s.uri === "skill://deploy/SKILL.md")!);
    expect(f.verified).toBe(true);
    expect(f.text).toContain("sk-live-12345");
  });

  it("policy.skills denies a whole skill: hidden from the list, refused on get and on file reads, audited", async () => {
    const { consumer, audit } = await skillRig({ policy: { skills: { deny: ["a.secret-sauce", "b.*"] } } });
    const skills = await consumer.listSkills("gw");
    expect(skills.map((s) => s.uri)).toEqual(["skill://a/deploy/SKILL.md"]);
    await expect(consumer.getSkill("skill://a/secret-sauce/SKILL.md", "gw")).rejects.toBeTruthy();
    await expect(consumer.getSkill("skill://b/deploy/SKILL.md", "gw")).rejects.toBeTruthy();
    await consumer.readSkillFile(skills[0]!);
    const kinds = audit.filter((e) => e.kind === "skill").map((e) => `${e.server}:${e.outcome}`);
    expect(kinds).toContain("a:ok");
  });

  it("policy.skills approve holds a skill for a human; the approver can refuse", async () => {
    const asked: string[] = [];
    const { consumer, audit } = await skillRig({
      policy: { skills: { approve: ["a.secret-sauce"] } },
      approval: { handler: (r) => (asked.push(`${r.kind}:${r.server}:${r.target}`), "deny") },
    });
    const skills = await consumer.listSkills("gw");
    const sauce = skills.find((s) => s.uri.includes("secret-sauce"))!;
    await expect(consumer.readSkillFile(sauce)).rejects.toBeTruthy();
    expect(asked).toContain("skill:a:skill://secret-sauce/SKILL.md");
    expect(audit.some((e) => e.kind === "skill" && e.outcome === "denied")).toBe(true);
    // An ordinary skill needs no approval.
    await consumer.readSkillFile(skills.find((s) => s.uri === "skill://a/deploy/SKILL.md")!);
    expect(asked).toHaveLength(1);
  });

  it("declarative skill rules: allow-list, glob over a skill's files, relative file refs resolved by the skill", () => {
    const p = compilePolicy({ skills: { allow: ["a.deploy"], deny: ["a.deploy/references/*"] } });
    const b = { server: "a", destructive: false, readOnly: false, kind: "skill" as const };
    expect(p({ ...b, target: "skills", method: "skills/list" } as never)).toBe("allow");
    expect(p({ ...b, target: "skill://deploy/SKILL.md", method: "skills/get" } as never)).toBe("allow");
    expect(p({ ...b, target: "skill://other/SKILL.md", method: "skills/get" } as never)).toBe("deny");
    expect(p({ ...b, target: "skill://deploy/references/KEYS.md", method: "skills/read" } as never)).toBe("deny");
    // A relative ref is judged by the skill it belongs to (args.skill), not by the bare ref.
    expect(p({ ...b, target: "references/KEYS.md", args: { skill: "skill://deploy/SKILL.md" }, method: "skills/read" } as never)).toBe("allow");
    expect(explainPolicy({ skills: { approve: ["a.x"] } })({ ...b, target: "skill://x/SKILL.md", method: "skills/get" } as never)).toMatchObject({ decision: "approve" });
    const hide = policySkillFilter({ skills: { deny: ["a.x"] } })!;
    expect(hide("a", "skill://x/SKILL.md")).toBe(false);
    expect(hide("a", "skill://y/SKILL.md")).toBe(true);
    expect(policySkillFilter({})).toBeUndefined();
    expect(policySkillFilter(() => "allow")).toBeUndefined();
  });
});

// ── MCP Apps ────────────────────────────────────────────────────────────────────

describe("MCP Apps through the gate", () => {
  const DECL = { mimeTypes: ["text/html;profile=mcp-app"] };
  const spec = {
    tools: [{ name: "show", _meta: { ui: { resourceUri: "ui://app/view" } }, handler: () => ({ content: [{ type: "text", text: "shown" }] }) }],
    resources: [{ uri: "ui://app/view", mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: {} } }, read: () => ({ text: "<html/>" }) }],
  };
  async function uiRig(config: Partial<GateConfig>, declare: Record<string, object>) {
    const up = new MockMCPServer(spec as never, { era: "modern" });
    const gate = await createGate({ ...config, upstreams: { up: { transport: up.transport, versions: ["2026-07-28"] } as never } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gate.server.connect(st);
    const consumer = new Client({ name: "host", version: "1" }, { capabilities: { extensions: declare } as never });
    await consumer.connect(ct);
    closers.push(async () => { await consumer.close(); await gate.close(); await up.close(); });
    return { up, consumer, gate };
  }

  it("a host behind the gate negotiates UI with the upstream, and gets _meta.ui and ui:// resources", async () => {
    const { up, consumer } = await uiRig({}, { [UI_EXT]: DECL });
    expect(consumer.getServerCapabilities()?.extensions?.[UI_EXT]).toEqual({});
    expect((await consumer.listTools()).tools[0]!._meta).toMatchObject({ ui: { resourceUri: "ui://app/view" } });
    await consumer.callTool({ name: "up.show", arguments: {} });
    expect(up.clientCapabilities()?.extensions?.[UI_EXT]).toEqual(DECL); // the host's own declaration, not the gate's default
    expect((await consumer.readResource({ uri: "ui://app/view" })).contents[0]).toMatchObject({ text: "<html/>", _meta: { ui: { csp: {} } } });
  });

  it("without a declaration the host sees no UI metadata; with UI denied nothing is declared to the upstream", async () => {
    const { consumer } = await uiRig({}, {});
    expect((await consumer.listTools()).tools[0]!._meta?.ui).toBeUndefined();
    expect((await consumer.listResources()).resources).toEqual([]);
    const off = await uiRig({ extensions: { deny: [UI_EXT] } }, { [UI_EXT]: DECL });
    await off.consumer.callTool({ name: "up.show", arguments: {} });
    expect(off.up.clientCapabilities()?.extensions?.[UI_EXT]).toBeUndefined();
  });
});

describe("validateGateConfig: extensions and skill rules", () => {
  const up = { upstreams: { u: { url: "http://localhost:1/mcp" } } };
  it("accepts the new keys and rejects typos", () => {
    expect(() => validateGateConfig({ ...up, extensions: { allow: [TASKS], deny: [UI_EXT], passthrough: { "x/y": { methods: ["y/poll"] } }, tasksSecret: "0123456789abcdef", taskResolveMs: 5 }, policy: { skills: { deny: ["a.b"] } } })).not.toThrow();
    expect(() => validateGateConfig({ ...up, extensions: { pasthrough: {} } })).toThrow(/unknown key "pasthrough"/);
    expect(() => validateGateConfig({ ...up, extensions: { passthrough: { "x/y": { methods: [] } } } })).toThrow(/non-empty/);
    expect(() => validateGateConfig({ ...up, extensions: { passthrough: { "x/y": { method: ["a"] } } } })).toThrow(/unknown key/);
    expect(() => validateGateConfig({ ...up, extensions: { tasksSecret: "short" } })).toThrow(/tasksSecret/);
    expect(() => validateGateConfig({ ...up, extensions: "all" })).toThrow(/"extensions" must be an object/);
    expect(() => validateGateConfig({ ...up, policy: { skills: { deny: "x" } } })).toThrow(/glob strings/);
    expect(() => validateGateConfig({ ...up, policy: { skills: { block: [] } } })).toThrow(/unknown key "block"/);
    expect(() => validateGateConfig({ ...up, policy: { skills: [] } })).toThrow(/policy.skills/);
  });
});
