// #82 items 3, 4, 5 — tasks, skills and extension negotiation at the gateway.
// Legacy-era wires and an injected skills SDK, so everything here runs on SDK 2.0.0 and newer.

import { describe, it, expect, vi } from "vitest";
import * as z from "zod";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { MCPClient, type CallAuditEntry } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGateway, createGatewayHandler, type GatewayOptions } from "../src/server/gateway.js";
import { TaskIds, TaskNotFoundError, UI_EXT, advertisedExtensions, extensionAllowed, toGatewaySkill } from "../src/server/gatewayExtensions.js";
import { authorize, AuthorizationError } from "../src/server/authorize.js";
import { TASKS_EXT } from "../src/core/tasksExt.js";
import { sdkSupportsModernTasks } from "../src/core/tasksProbe.js";
import { SKILLS_EXT } from "../src/core/skillsExt.js";
import type { SkillsSdk } from "../src/core/skills.js";

vi.setConfig({ testTimeout: 30_000 });

const loose = z.looseObject({});
const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: Array<() => Promise<unknown>> = [];
import { afterEach } from "vitest";
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
});

const taskTool = (name: string, text: string, extra: Record<string, unknown> = {}) => ({
  name,
  task: true,
  taskDelayMs: 30,
  handler: () => ({ content: [{ type: "text", text }] }),
  ...extra,
});

/** Two task-capable upstreams behind one gateway, and a consumer that declares `declare`. */
async function taskRig(opts: { era?: "legacy" | "modern"; gateway?: GatewayOptions; declare?: Record<string, object>; interceptors?: ConstructorParameters<typeof MCPClient>[0]["interceptors"]; audit?: CallAuditEntry[] } = {}) {
  const era = opts.era ?? "legacy";
  const a = new MockMCPServer({ tools: [taskTool("crunch", "a-done"), { name: "plain", handler: () => ({ content: [{ type: "text", text: "a-sync" }] }) }] }, { era });
  const b = new MockMCPServer({ tools: [taskTool("crunch", "b-done")] }, { era });
  const upstream = new MCPClient({
    servers: { a: { transport: a.transport }, b: { transport: b.transport } },
    ...(era === "modern" ? { versions: ["2026-07-28"] } : {}),
    ...(opts.interceptors ? { interceptors: opts.interceptors } : {}),
    onCall: (e) => void opts.audit?.push(e),
  });
  await upstream.connect();
  const gateway = createGateway(upstream, { audit: (e) => void opts.audit?.push(e), ...opts.gateway });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.connect(st);
  const consumer = new Client({ name: "consumer", version: "1" }, { capabilities: { extensions: opts.declare ?? { [TASKS_EXT]: {} } } as never });
  await consumer.connect(ct);
  closers.push(async () => {
    await consumer.close();
    await gateway.close();
    await upstream.close();
    await a.close();
    await b.close();
  });
  const call = (name: string, meta?: Record<string, unknown>) =>
    consumer.request({ method: "tools/call", params: { name, arguments: {}, ...(meta ? { _meta: meta } : {}) } } as never, loose as never) as Promise<Record<string, unknown>>;
  const task = (method: "tasks/get" | "tasks/cancel" | "tasks/update", taskId: string, meta?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    consumer.request({ method, params: { taskId, ...extra, ...(meta ? { _meta: meta } : {}) } } as never, loose as never) as Promise<Record<string, unknown>>;
  const finish = async (taskId: string, meta?: Record<string, unknown>) => {
    for (let i = 0; i < 100; i++) {
      const t = await task("tasks/get", taskId, meta);
      if (t.status === "completed" || t.status === "failed" || t.status === "cancelled") return t;
      await sleep(15);
    }
    throw new Error("task did not finish");
  };
  return { a, b, upstream, gateway, consumer, call, task, finish };
}

describe("extension negotiation", () => {
  it("offers an extension only to a consumer that declared it, when an upstream advertises it", async () => {
    const declared = await taskRig({ declare: { [TASKS_EXT]: {} } });
    expect(declared.consumer.getServerCapabilities()?.extensions).toEqual({ [TASKS_EXT]: {} });
    const bare = await taskRig({ declare: {} });
    expect(bare.consumer.getServerCapabilities()?.extensions).toBeUndefined();
  });

  it("does not offer what no upstream advertises, or what policy denies", async () => {
    // skills is declared but nobody advertises it
    const none = await taskRig({ declare: { [TASKS_EXT]: {}, [SKILLS_EXT]: {} } });
    expect(Object.keys(none.consumer.getServerCapabilities()?.extensions ?? {})).toEqual([TASKS_EXT]);
    const denied = await taskRig({ gateway: { extensions: { deny: [TASKS_EXT] } } });
    expect(denied.consumer.getServerCapabilities()?.extensions).toBeUndefined();
    const allowOnly = await taskRig({ gateway: { extensions: { allow: [SKILLS_EXT] } } });
    expect(allowOnly.consumer.getServerCapabilities()?.extensions).toBeUndefined();
  });

  it("advertisedExtensions / extensionAllowed compute the offer without a consumer", async () => {
    const { upstream } = await taskRig();
    expect(advertisedExtensions(upstream, undefined)).toEqual({ [TASKS_EXT]: {} });
    expect(advertisedExtensions(upstream, undefined, {})).toEqual({});
    expect(extensionAllowed(undefined, UI_EXT)).toBe(true);
    expect(extensionAllowed({ allow: [TASKS_EXT] }, UI_EXT)).toBe(false);
    expect(extensionAllowed({ deny: [UI_EXT], passthrough: { [UI_EXT]: { methods: [] } } }, UI_EXT)).toBe(false);
    expect(extensionAllowed({ passthrough: { "x.test/ext": { methods: [] } } }, "x.test/ext")).toBe(true);
  });
});

describe("tasks through the gateway", () => {
  it("forwards a task handle to a declaring consumer, namespaced, and routes get to the owning upstream", async () => {
    const { call, task, finish } = await taskRig();
    const ca = await call("a.crunch");
    const cb = await call("b.crunch");
    expect(String(ca.taskId)).toMatch(/^gw1\./);
    expect(ca.taskId).not.toBe(cb.taskId);
    // Each id goes to its own upstream (both upstreams number their tasks from 1: raw ids would collide).
    const da = await finish(String(ca.taskId));
    const db = await finish(String(cb.taskId));
    expect(textOf(da.result)).toBe("a-done");
    expect(textOf(db.result)).toBe("b-done");
    expect(da.taskId).toBe(ca.taskId); // the consumer only ever sees the namespaced id
    expect(await task("tasks/get", String(ca.taskId))).toMatchObject({ status: "completed" });
  });

  it("a plain (non-task) tool still answers synchronously for a declaring consumer", async () => {
    const { call } = await taskRig();
    expect(textOf(await call("a.plain"))).toBe("a-sync");
  });

  it("a consumer that did not declare tasks gets the final result (the old behaviour)", async () => {
    const { call, a } = await taskRig({ declare: {} });
    const r = await call("a.crunch");
    expect(textOf(r)).toBe("a-done");
    expect(r.taskId).toBeUndefined();
    void a;
  });

  it("with tasks denied by policy, a declaring consumer gets the final result and no tasks methods", async () => {
    const { call, task } = await taskRig({ gateway: { extensions: { deny: [TASKS_EXT] } } });
    expect(textOf(await call("a.crunch"))).toBe("a-done");
    await expect(task("tasks/get", "gw1.x.y")).rejects.toMatchObject({ code: -32601 });
  });

  it("a method the consumer was not offered does not exist for it", async () => {
    const { task } = await taskRig({ declare: {} });
    await expect(task("tasks/get", "gw1.x.y")).rejects.toMatchObject({ code: -32601 });
  });

  it("a second tenant cannot poll, answer or cancel the first tenant's task", async () => {
    const audit: CallAuditEntry[] = [];
    const { call, task, finish } = await taskRig({ audit });
    const t1 = { partition: "tenant-1", principal: "alice" };
    const t2 = { partition: "tenant-2", principal: "mallory" };
    const created = await call("a.crunch", t1);
    const id = String(created.taskId);

    for (const method of ["tasks/get", "tasks/cancel", "tasks/update"] as const) {
      await expect(task(method, id, t2)).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    }
    // Same partition, different principal; and no tenant claim at all: refused too.
    await expect(task("tasks/get", id, { partition: "tenant-1", principal: "bob" })).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    await expect(task("tasks/get", id)).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });

    // The owner is unaffected: the foreign cancel did not land.
    const done = await finish(id, t1);
    expect(done.status).toBe("completed");
    // The refusals are audited as denials, without leaking the id.
    const denied = audit.filter((e) => e.kind === "task" && e.outcome === "denied");
    expect(denied.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(denied)).not.toContain(id);
  });

  it("an id altered, forged or minted under another secret is refused like an unknown one", async () => {
    const { call, task } = await taskRig();
    const id = String((await call("a.crunch")).taskId);
    const [prefix, payload, sig] = id.split(".");
    const retarget = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), s: "b" })).toString("base64url");
    for (const bad of [`${prefix}.${retarget}.${sig}`, `${prefix}.${payload}.${sig!.slice(0, -2)}AA`, "gw1.", "gw1.a.b.c", "task-1", ""]) {
      await expect(task("tasks/get", bad)).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    }
    const other = await new TaskIds("another-secret-another-secret").mint({ server: "a", tool: "crunch", taskId: "task-1" });
    await expect(task("tasks/get", other)).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
  });

  it("a shared secret lets any gateway instance route an id; TaskIds enforces its own contract", async () => {
    const x = new TaskIds("0123456789abcdef-secret");
    const y = new TaskIds("0123456789abcdef-secret");
    const id = await x.mint({ server: "a", tool: "t", taskId: "42", partition: "p", principal: { sub: "u" } });
    await expect(y.open(id, { partition: "p", principal: { sub: "u" } })).resolves.toMatchObject({ server: "a", tool: "t", taskId: "42", partition: "p" });
    await expect(y.open(id, { partition: "q", principal: { sub: "u" } })).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(() => new TaskIds("short")).toThrow(/at least 16/);
  });

  it("authorize and audit run on task polls and cancels", async () => {
    const audit: CallAuditEntry[] = [];
    const seen: Array<{ kind: string; method?: string; target: string; server: string }> = [];
    const policy = authorize((req) => {
      seen.push({ kind: req.kind, method: req.method, target: req.target, server: req.server });
      return req.kind === "task" && req.method === "tasks/cancel" ? "deny" : "allow";
    });
    const { call, task, finish } = await taskRig({ interceptors: [policy], audit });
    const id = String((await call("b.crunch")).taskId);
    await expect(task("tasks/cancel", id)).rejects.toMatchObject({ code: -32003 });
    await finish(id);
    expect(seen).toContainEqual({ kind: "task", method: "tasks/cancel", target: "crunch", server: "b" });
    expect(seen).toContainEqual({ kind: "task", method: "tasks/get", target: "crunch", server: "b" });
    expect(audit.find((e) => e.kind === "task" && e.outcome === "denied")).toMatchObject({ server: "b", target: "crunch" });
    expect(audit.some((e) => e.kind === "task" && e.outcome === "ok" && e.server === "b")).toBe(true);
    void AuthorizationError;
  });

  it("tasks/update answers pass through the answer guard, and input_required is audited as a request", async () => {
    const audit: CallAuditEntry[] = [];
    const guard = vi.fn(async (req: { kind: string; server: string; target: string; inputResponses: Record<string, unknown> }) => ({
      inputResponses: Object.fromEntries(Object.entries(req.inputResponses).map(([k, v]) => [k, { ...(v as object), content: { colour: "[REDACTED]" } }])),
      redactedFields: ["q0.content.colour"],
    }));
    const a = new MockMCPServer(
      {
        tools: [
          {
            name: "ask",
            task: true,
            taskDelayMs: 5,
            handler: async (_args: Record<string, unknown>, ctx: { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> }) => {
              const r = await ctx.elicit({ message: "Pick", requestedSchema: { type: "object", properties: { colour: { type: "string" } } } });
              return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content)}` }] };
            },
          },
        ],
      },
      { era: "legacy" },
    );
    const upstream = new MCPClient({ servers: { a: { transport: a.transport } }, onCall: (e) => void audit.push(e) });
    await upstream.connect();
    const gateway = createGateway(upstream, { guardAnswers: guard as never });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: { extensions: { [TASKS_EXT]: {} } } as never });
    await consumer.connect(ct);
    closers.push(async () => { await consumer.close(); await gateway.close(); await upstream.close(); await a.close(); });
    const req = (method: string, params: Record<string, unknown>) => consumer.request({ method, params } as never, loose as never) as Promise<Record<string, any>>;

    const id = String((await req("tools/call", { name: "a.ask", arguments: {} })).taskId);
    let t: Record<string, any> = {};
    for (let i = 0; i < 100 && t.status !== "input_required"; i++) {
      t = await req("tasks/get", { taskId: id });
      await sleep(10);
    }
    expect(t.status).toBe("input_required");
    expect(t.inputRequests.q0.method).toBe("elicitation/create");
    await req("tasks/update", { taskId: id, inputResponses: { q0: { action: "accept", content: { colour: "secret-red" } } } });
    for (let i = 0; i < 100 && t.status !== "completed"; i++) {
      t = await req("tasks/get", { taskId: id });
      await sleep(10);
    }
    expect(guard).toHaveBeenCalledOnce();
    expect(guard.mock.calls[0]![0]).toMatchObject({ kind: "task", server: "a", target: "ask" });
    expect(textOf(t.result)).toBe('accept:{"colour":"[REDACTED]"}'); // what the upstream received was the guarded answer
    const phases = audit.filter((e) => e.interaction).map((e) => [e.kind, e.interaction!.phase]);
    expect(phases).toContainEqual(["task", "request"]);
    expect(phases).toContainEqual(["task", "response"]);
    expect(audit.find((e) => e.interaction?.redactedFields)?.interaction?.redactedFields).toEqual(["q0.content.colour"]);
  });

  it("a refusing answer guard stops the tasks/update before it reaches the upstream", async () => {
    const { call, task, a } = await taskRig({
      gateway: { guardAnswers: async () => { throw new AuthorizationError("denied: nope"); } },
    });
    const id = String((await call("a.crunch")).taskId);
    await expect(task("tasks/update", id, undefined, { inputResponses: { q0: { action: "accept", content: {} } } })).rejects.toMatchObject({ code: -32003 });
    void a;
  });

  it("a gateway built on a client whose upstream ignores the declaration still resolves the task for a non-declaring consumer", async () => {
    // A stub client: tools/call answers with a task handle regardless; tasks/get completes after one poll.
    let polls = 0;
    const forward = vi.fn(async (_s: string, method: string) => {
      if (method === "tasks/cancel") return {};
      return ++polls < 2 ? { taskId: "u1", status: "working", pollIntervalMs: 1 } : { taskId: "u1", status: "completed", result: { content: [{ type: "text", text: "resolved" }] } };
    });
    const stub = {
      connections: () => [{ name: "a", capabilities: { extensions: { [TASKS_EXT]: {} } }, supports: () => false, tools: new Map(), resources: new Map(), era: "legacy" }],
      connection: () => ({ era: "legacy" }),
      listTools: () => [{ name: "t" }],
      callTool: async () => ({ taskId: "u1", status: "working", createdAt: "x", lastUpdatedAt: "x", ttlMs: null, content: [] }),
      forward,
      subscribeCapabilities: () => () => {},
    } as unknown as MCPClient;
    const gateway = createGateway(stub);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: {} });
    await consumer.connect(ct);
    closers.push(async () => { await consumer.close(); await gateway.close(); });
    expect(textOf(await consumer.callTool({ name: "a.t", arguments: {} }))).toBe("resolved");
    expect(forward.mock.calls.map((c) => c[1])).toEqual(["tasks/get", "tasks/get"]);
  });
});

describe("tasks against a modern (2026-07-28) upstream", () => {
  it("the consumer's tasks declaration is what reaches the upstream, per request", async () => {
    const yes = await taskRig({ era: "modern" });
    const created = await yes.call("a.crunch");
    expect(String(created.taskId)).toMatch(/^gw1\./);
    expect(yes.a.clientCapabilities()?.extensions?.[TASKS_EXT]).toEqual({});

    const no = await taskRig({ era: "modern", declare: {} });
    // Not declared: the gate's own (always-on) tasks declaration is NOT passed on, so the upstream runs it synchronously.
    expect(textOf(await no.call("a.crunch"))).toBe("a-done");
    expect(no.a.clientCapabilities()?.extensions?.[TASKS_EXT]).toBeUndefined();
  });

  it("polls through the gate where the installed SDK can send tasks/* on the modern wire; otherwise says why", async () => {
    const { call, task, finish, upstream } = await taskRig({ era: "modern" });
    const id = String((await call("b.crunch", { partition: "t1" })).taskId);
    const capable = await sdkSupportsModernTasks(upstream.connection("b")!.sdk as never);
    if (capable) {
      const done = await finish(id, { partition: "t1" });
      expect(textOf(done.result)).toBe("b-done");
    } else {
      // SDK 2.0.0 era-gates tasks/* off the modern wire: the gate surfaces that, and ownership is still enforced first.
      await expect(task("tasks/get", id, { partition: "t1" })).rejects.toMatchObject({ message: expect.stringMatching(/protocol version|not supported/i) });
    }
    await expect(task("tasks/get", id, { partition: "t2" })).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
  });
});

describe("generic extension pass-through", () => {
  async function rig(passthrough: boolean, declare: Record<string, object> = { "x.test/events": {} }, upstreams = 1) {
    const ups: Array<{ upstream: Server; calls: Array<Record<string, unknown>> }> = [];
    const conf: Record<string, { transport: () => never }> = {};
    for (let i = 0; i < upstreams; i++) {
      const calls: Array<Record<string, unknown>> = [];
      const upstream = new Server({ name: `ext${i}`, version: "1" }, { capabilities: { tools: {}, extensions: { "x.test/events": { poll: true } } } as never });
      upstream.setRequestHandler("tools/list", () => ({ tools: [] }));
      upstream.setRequestHandler("events/poll" as never, { params: z.looseObject({}) } as never, ((p: Record<string, unknown>) => (calls.push(p), { events: [`from-${i}`], secretish: "token-123" })) as never);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await upstream.connect(st);
      conf[`e${i}`] = { transport: () => ct as never };
      ups.push({ upstream, calls });
    }
    const audit: CallAuditEntry[] = [];
    const client = new MCPClient({ servers: conf as never, onCall: (e) => void audit.push(e) });
    await client.connect();
    const gateway = createGateway(client, passthrough ? { extensions: { passthrough: { "x.test/events": { methods: ["events/poll"] } } } } : {});
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: { extensions: declare } as never });
    await consumer.connect(ct);
    closers.push(async () => { await consumer.close(); await gateway.close(); await client.close(); for (const u of ups) await u.upstream.close(); });
    const poll = (meta?: Record<string, unknown>) => consumer.request({ method: "events/poll", params: { since: 1, ...(meta ? { _meta: meta } : {}) } } as never, loose as never) as Promise<Record<string, unknown>>;
    return { consumer, poll, audit, ups };
  }

  it("is off by default: an unknown extension method does not exist and the extension is not offered", async () => {
    const { consumer, poll } = await rig(false);
    expect(consumer.getServerCapabilities()?.extensions).toBeUndefined();
    await expect(poll()).rejects.toMatchObject({ code: -32601 });
  });

  it("with an allowlist: offered to a declaring consumer, routed to the one upstream, audited", async () => {
    const { consumer, poll, audit, ups } = await rig(true);
    expect(consumer.getServerCapabilities()?.extensions).toEqual({ "x.test/events": { poll: true } });
    expect(await poll({ principal: "p1" })).toMatchObject({ events: ["from-0"] });
    expect(ups[0]!.calls[0]).toMatchObject({ since: 1 });
    expect(audit).toContainEqual(expect.objectContaining({ kind: "extension", target: "events/poll", server: "e0", outcome: "ok", principal: "p1" }));
  });

  it("is not available to a consumer that did not declare the extension", async () => {
    const { consumer, poll } = await rig(true, {});
    expect(consumer.getServerCapabilities()?.extensions).toBeUndefined();
    await expect(poll()).rejects.toMatchObject({ code: -32601 });
  });

  it("needs the upstream named when several advertise the extension", async () => {
    const { poll, ups } = await rig(true, { "x.test/events": {} }, 2);
    await expect(poll()).rejects.toMatchObject({ code: -32602 });
    expect(await poll({ "io.johnhenry.mcp-query/server": "e1" })).toMatchObject({ events: ["from-1"] });
    await expect(poll({ "io.johnhenry.mcp-query/server": "nope" })).rejects.toMatchObject({ code: -32602 });
    expect(ups[0]!.calls).toHaveLength(0);
  });

  it("a denied extension is never passed through even if allowlisted", async () => {
    const calls: unknown[] = [];
    const upstream = new Server({ name: "e", version: "1" }, { capabilities: { tools: {}, extensions: { "x.test/events": {} } } as never });
    upstream.setRequestHandler("tools/list", () => ({ tools: [] }));
    upstream.setRequestHandler("events/poll" as never, { params: z.looseObject({}) } as never, ((p: unknown) => (calls.push(p), {})) as never);
    const [uct, ust] = InMemoryTransport.createLinkedPair();
    await upstream.connect(ust);
    const client = new MCPClient({ servers: { e: { transport: () => uct as never } } });
    await client.connect();
    const gateway = createGateway(client, { extensions: { deny: ["x.test/events"], passthrough: { "x.test/events": { methods: ["events/poll"] } } } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: { extensions: { "x.test/events": {} } } as never });
    await consumer.connect(ct);
    closers.push(async () => { await consumer.close(); await gateway.close(); await client.close(); await upstream.close(); });
    await expect(consumer.request({ method: "events/poll", params: {} } as never, loose as never)).rejects.toMatchObject({ code: -32601 });
    expect(calls).toHaveLength(0);
  });
});

describe("MCP Apps (UI extension) through the gateway", () => {
  const UI_DECL = { mimeTypes: ["text/html;profile=mcp-app"] };
  const uiServer = () =>
    new MockMCPServer(
      {
        tools: [{ name: "show", _meta: { ui: { resourceUri: "ui://app/view" } }, handler: () => ({ content: [{ type: "text", text: "shown" }] }) }],
        resources: [{ uri: "ui://app/view", mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [] } } }, read: () => ({ text: "<html>app</html>" }) }],
      },
      { era: "modern" },
    );

  async function rig(declare: Record<string, object>, gateway: GatewayOptions = {}) {
    const up = uiServer();
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, versions: ["2026-07-28"] });
    await upstream.connect();
    const gw = createGateway(upstream, gateway);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gw.connect(st);
    const consumer = new Client({ name: "host", version: "1" }, { capabilities: { extensions: declare } as never });
    await consumer.connect(ct);
    closers.push(async () => { await consumer.close(); await gw.close(); await upstream.close(); await up.close(); });
    return { up, consumer, upstream };
  }

  it("the consumer's UI declaration reaches the upstream; _meta.ui and ui:// resources pass through", async () => {
    const { up, consumer } = await rig({ [UI_EXT]: UI_DECL });
    expect(consumer.getServerCapabilities()?.extensions?.[UI_EXT]).toEqual({});
    const tool = (await consumer.listTools()).tools.find((t) => t.name === "a.show")!;
    expect(tool._meta).toMatchObject({ ui: { resourceUri: "ui://app/view" } });
    expect((await consumer.listResources()).resources.map((r) => r.uri)).toContain("ui://app/view");
    expect(textOf(await consumer.callTool({ name: "a.show", arguments: {} }))).toBe("shown");
    // The upstream saw exactly what the consumer declared (modern upstream: per-request client capabilities).
    expect(up.clientCapabilities()?.extensions?.[UI_EXT]).toEqual(UI_DECL);
    const read = (await consumer.readResource({ uri: "ui://app/view" })).contents[0] as { text: string; mimeType: string; _meta?: unknown };
    expect(read).toMatchObject({ text: "<html>app</html>", mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: [] } } } });
  });

  it("a consumer that did not declare it gets no UI metadata and the upstream is told nothing about UI", async () => {
    const { up, consumer } = await rig({});
    expect(consumer.getServerCapabilities()?.extensions).toBeUndefined();
    const tool = (await consumer.listTools()).tools.find((t) => t.name === "a.show")!;
    expect(tool._meta?.ui).toBeUndefined();
    expect((await consumer.listResources()).resources.map((r) => r.uri)).not.toContain("ui://app/view");
    await consumer.callTool({ name: "a.show", arguments: {} });
    expect(up.clientCapabilities()?.extensions?.[UI_EXT]).toBeUndefined();
  });

  it("policy can refuse the UI extension even for a declaring consumer", async () => {
    const { up, consumer } = await rig({ [UI_EXT]: UI_DECL }, { extensions: { deny: [UI_EXT] } });
    expect(consumer.getServerCapabilities()?.extensions).toBeUndefined();
    await consumer.callTool({ name: "a.show", arguments: {} });
    expect(up.clientCapabilities()?.extensions?.[UI_EXT]).toBeUndefined();
  });

  it("also negotiates over a modern (2026-07-28) consumer connection", async () => {
    const up = uiServer();
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, versions: ["2026-07-28"] });
    await upstream.connect();
    const handler = createGatewayHandler(upstream);
    const consumer = new MCPClient({
      servers: { gw: { transport: () => new StreamableHTTPClientTransport(new URL("http://gw.local/mcp"), { fetch: (u, i) => handler.fetch(new Request(u as string, i)) }) } },
      versions: ["2026-07-28"],
      extensions: { [UI_EXT]: UI_DECL },
    });
    await consumer.connect();
    closers.push(async () => { await consumer.close(); await handler.close(); await upstream.close(); await up.close(); });
    expect(consumer.listTools("gw").find((t) => t.name === "a.show")?._meta).toMatchObject({ ui: { resourceUri: "ui://app/view" } });
    await consumer.callTool("gw.a.show", {});
    expect(up.clientCapabilities()?.extensions?.[UI_EXT]).toEqual(UI_DECL);
  });
});

// ── skills ──────────────────────────────────────────────────────────────────────

const sha256 = async (bytes: Uint8Array) => "sha256:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

class VerificationError extends Error {
  override name = "SkillVerificationError";
  constructor(readonly reason: string, readonly uri: string, readonly differences: readonly string[] = []) {
    super(`skill verification failed: ${reason}`);
  }
}

/**
 * A skills SDK that speaks the real wire (skills/list, skills/get, resources/read over the SDK client it is
 * handed) and verifies size and sha256 against the manifest like the real one. Used on BOTH sides of the gate,
 * so a digest that verifies at the consumer proves the gate did not touch the bytes.
 */
function wireSkillsSdk(): () => Promise<SkillsSdk> {
  class SkillsClient {
    constructor(private readonly raw: Client) {}
    async list() {
      return this.raw.request({ method: "skills/list", params: {} } as never, z.looseObject({ skills: z.array(z.any()) }) as never) as Promise<{ skills: never[]; ttlMs?: number; cacheScope?: "public" | "private" }>;
    }
    async get(uri: string) {
      return this.raw.request({ method: "skills/get", params: { uri } } as never, z.looseObject({ skill: z.any() }) as never) as Promise<{ skill: never }>;
    }
    async read(skill: { uri: string; resources: unknown }, ref?: string) {
      const root = skill.uri.slice(0, skill.uri.lastIndexOf("/") + 1);
      const uri = ref === undefined ? skill.uri : /^[a-z][a-z0-9+.-]*:/i.test(ref) ? ref : root + ref.replace(/^\.\//, "");
      const res = await this.raw.readResource({ uri });
      const c = res.contents[0] as { text?: string; blob?: string; mimeType?: string };
      const bytes = c.text !== undefined ? new TextEncoder().encode(c.text) : Uint8Array.from(atob(c.blob ?? ""), (ch) => ch.charCodeAt(0));
      if (skill.resources === "dynamic") return { uri, bytes, text: c.text, verified: false };
      const entry = (skill.resources as Array<{ uri: string; digest: string; size: number }>).find((r) => r.uri === uri);
      if (!entry) throw new VerificationError("unlisted", uri);
      if (entry.size !== bytes.length) throw new VerificationError("size", uri);
      if (entry.digest !== (await sha256(bytes))) throw new VerificationError("digest", uri);
      return { uri, bytes, text: c.text, mimeType: c.mimeType, verified: true };
    }
  }
  return async () => ({ SkillsClient }) as unknown as SkillsSdk;
}

describe("skills through the gateway", () => {
  const skillA = { name: "git-commit", description: "A's commit style", files: { "references/STYLE.md": "A: use imperative mood\n" } };
  const skillB = { name: "git-commit", description: "B's commit style", body: "B body with a token sk-live-123456\n", files: { "references/STYLE.md": "B: use past tense\n" } };

  async function rig(opts: { gateway?: GatewayOptions; tamperB?: boolean; interceptors?: ConstructorParameters<typeof MCPClient>[0]["interceptors"]; audit?: CallAuditEntry[]; declare?: boolean } = {}) {
    const a = new MockMCPServer({ skills: [skillA, { name: "only-a", description: "A only" }] }, { era: "legacy" });
    const b = new MockMCPServer({ skills: [{ ...skillB, ...(opts.tamperB ? { tamper: "digest" as const } : {}) }] }, { era: "legacy" });
    const upstream = new MCPClient({
      servers: { a: { transport: a.transport }, b: { transport: b.transport } },
      skillsSdk: wireSkillsSdk(),
      ...(opts.interceptors ? { interceptors: opts.interceptors } : {}),
      onCall: (e) => void opts.audit?.push(e),
    });
    await upstream.connect();
    const gateway = createGateway(upstream, opts.gateway);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const consumer = new MCPClient({
      servers: { gw: { transport: () => ct } },
      skillsSdk: wireSkillsSdk(),
      ...(opts.declare === false ? {} : { extensions: { [SKILLS_EXT]: {} } }),
    });
    await consumer.connect();
    closers.push(async () => { await consumer.close(); await gateway.close(); await upstream.close(); await a.close(); await b.close(); });
    return { a, b, upstream, gateway, consumer };
  }

  it("lists skills from two upstreams with the originating server in the URI, and digests verify at the consumer", async () => {
    const { consumer } = await rig();
    expect(consumer.connection("gw")!.supports("skills")).toBe(true);
    const skills = await consumer.listSkills("gw");
    expect(skills.map((s) => s.uri).sort()).toEqual(["skill://a/git-commit/SKILL.md", "skill://a/only-a/SKILL.md", "skill://b/git-commit/SKILL.md"]);
    // Same skill name on two upstreams: two distinct, attributable entries.
    const gitA = skills.find((s) => s.uri.startsWith("skill://a/git-commit"))!;
    const gitB = skills.find((s) => s.uri.startsWith("skill://b/git-commit"))!;
    expect(gitA.frontmatter.description).toBe("A's commit style");
    expect(gitB.frontmatter.description).toBe("B's commit style");
    expect((gitA._meta as Record<string, unknown>)["io.johnhenry.mcp-query/server"]).toBe("a");
    expect((gitB._meta as Record<string, unknown>)["io.johnhenry.mcp-query/server"]).toBe("b");
    expect(gitA.resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "skill://a/git-commit/references/STYLE.md", digest: expect.stringMatching(/^sha256:/) })]));

    // Reading verifies size and sha256 against the (upstream's) manifest, on the consumer, through the gate.
    const md = await consumer.readSkillFile(gitB);
    expect(md.verified).toBe(true);
    expect(md.text).toContain("sk-live-123456"); // never rewritten
    const style = await consumer.readSkillFile(gitA, "references/STYLE.md");
    expect(style).toMatchObject({ verified: true, text: "A: use imperative mood\n" });
    expect((await consumer.readSkillFile(gitB, "references/STYLE.md")).text).toBe("B: use past tense\n"); // routed to B, not A
    // skills/get by gateway URI returns the same attributable entry.
    expect((await consumer.getSkill("skill://b/git-commit/SKILL.md", "gw")).frontmatter.description).toBe("B's commit style");
  });

  it("the digests the consumer sees are the upstream's digests, byte for byte", async () => {
    const { consumer, upstream } = await rig();
    const [viaGate] = (await consumer.listSkills("gw")).filter((s) => s.uri === "skill://a/only-a/SKILL.md");
    const direct = (await upstream.listSkills("a")).find((s) => s.uri === "skill://only-a/SKILL.md")!;
    expect((viaGate!.resources as Array<{ digest: string; size: number }>).map((r) => [r.digest, r.size])).toEqual((direct.resources as Array<{ digest: string; size: number }>).map((r) => [r.digest, r.size]));
  });

  it("an upstream that lies about a digest is refused at the gate and cannot be read through it", async () => {
    const { consumer } = await rig({ tamperB: true });
    const gitB = (await consumer.listSkills("gw")).find((s) => s.uri.startsWith("skill://b/"))!;
    await expect(consumer.readSkillFile(gitB)).rejects.toBeTruthy();
    // The honest upstream is unaffected.
    const gitA = (await consumer.listSkills("gw")).find((s) => s.uri.startsWith("skill://a/git-commit"))!;
    expect((await consumer.readSkillFile(gitA)).verified).toBe(true);
  });

  it("policy applies to skills: audit sees list / get / file read, and a policy can deny a whole skill", async () => {
    const audit: CallAuditEntry[] = [];
    const policy = authorize((req) => (req.kind === "skill" && req.server === "b" && req.method !== "skills/list" ? "deny" : "allow"));
    const { consumer } = await rig({ interceptors: [policy], audit });
    const skills = await consumer.listSkills("gw");
    const gitA = skills.find((s) => s.uri.startsWith("skill://a/git-commit"))!;
    const gitB = skills.find((s) => s.uri.startsWith("skill://b/"))!;
    await consumer.readSkillFile(gitA);
    await consumer.getSkill(gitA.uri, "gw");
    await expect(consumer.readSkillFile(gitB)).rejects.toBeTruthy();
    const seen = audit.filter((e) => e.kind === "skill").map((e) => `${e.server}:${e.outcome}`);
    expect(seen).toContain("a:ok");
    expect(seen).toContain("b:denied");
    expect(audit.filter((e) => e.kind === "skill" && e.server === "a").length).toBeGreaterThanOrEqual(3);
  });

  it("skillFilter hides a skill from the list and from reads", async () => {
    const { consumer } = await rig({ gateway: { skillFilter: (server, uri) => !(server === "b" && uri.includes("git-commit")) } });
    const skills = await consumer.listSkills("gw");
    expect(skills.map((s) => s.uri)).not.toContain("skill://b/git-commit/SKILL.md");
    await expect(consumer.getSkill("skill://b/git-commit/SKILL.md", "gw")).rejects.toBeTruthy();
  });

  it("a consumer that did not declare skills is not offered them", async () => {
    const { consumer, gateway } = await rig({ declare: false });
    expect(consumer.connection("gw")!.supports("skills")).toBe(false);
    void gateway;
    await expect(consumer.listSkills("gw")).rejects.toBeTruthy();
  });

  it("non-namespaced mode keeps URIs and attaches the origin in _meta", async () => {
    const { consumer } = await rig({ gateway: { namespace: false } });
    const skills = await consumer.listSkills("gw");
    const uris = skills.map((s) => s.uri);
    expect(uris.filter((u) => u === "skill://git-commit/SKILL.md")).toHaveLength(2); // the collision namespacing exists to avoid
    expect(skills.map((s) => (s._meta as Record<string, unknown>)["io.johnhenry.mcp-query/server"]).sort()).toEqual(["a", "a", "b"]);
    const only = skills.find((s) => s.uri === "skill://only-a/SKILL.md")!;
    expect((await consumer.readSkillFile(only)).verified).toBe(true);
  });

  it("toGatewaySkill rewrites only URIs and records the origin", () => {
    const entry = { server: "s", uri: "skill://x/SKILL.md", frontmatter: { name: "x", description: "d" }, resources: [{ uri: "skill://x/SKILL.md", digest: "sha256:aa", size: 1 }] };
    const out = toGatewaySkill(entry, true);
    expect(out).toMatchObject({ uri: "skill://s/x/SKILL.md", resources: [{ uri: "skill://s/x/SKILL.md", digest: "sha256:aa", size: 1 }], frontmatter: { name: "x" } });
    expect(toGatewaySkill({ ...entry, resources: "dynamic" as const }, true).resources).toBe("dynamic");
  });
});
