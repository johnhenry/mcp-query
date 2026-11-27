// Inbound auth at the gateway: ONE choke point (every registered request handler, including the
// task / skill / extension handlers) sees the verified principal and partition, never the consumer's claim.
// Legacy-era wires and a fake skills SDK, so this runs on the lockfile's SDK 2.0.0.

import { describe, it, expect, vi, afterEach } from "vitest";
import * as z from "zod";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { MCPClient, type CallAuditEntry } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGateway, type GatewayOptions } from "../src/server/gateway.js";
import { authorize } from "../src/server/authorize.js";
import { TASKS_EXT } from "../src/core/tasksExt.js";
import { SKILLS_EXT } from "../src/core/skillsExt.js";
import type { SkillsSdk } from "../src/core/skills.js";

vi.setConfig({ testTimeout: 30_000 });
const loose = z.looseObject({});
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
});

type Auth = { clientId: string; scopes: string[]; extra: { sub: string } } | undefined;
const as = (sub: string): Auth => ({ clientId: "app", scopes: ["mcp"], extra: { sub } });

/** Server-side transport that stamps the CURRENT verified AuthInfo onto every inbound message, as a verified HTTP front would. */
function authed(inner: InMemoryTransport, current: () => Auth) {
  return {
    start: () => inner.start(),
    send: (m: unknown, o?: unknown) => inner.send(m as never, o as never),
    close: () => inner.close(),
    set onmessage(h: ((m: unknown, extra?: Record<string, unknown>) => void) | undefined) {
      inner.onmessage = h ? (m, extra) => h(m, { ...(extra ?? {}), authInfo: current() }) : undefined;
    },
    get onmessage() {
      return inner.onmessage as never;
    },
    set onclose(h: (() => void) | undefined) { inner.onclose = h; },
    get onclose() { return inner.onclose; },
    set onerror(h: ((e: Error) => void) | undefined) { inner.onerror = h; },
    get onerror() { return inner.onerror; },
  };
}

function fakeSkillsSdk(): () => Promise<SkillsSdk> {
  class SkillsClient {
    constructor(private readonly raw: Client) {}
    async list() {
      return this.raw.request({ method: "skills/list", params: {} } as never, z.looseObject({ skills: z.array(z.any()) }) as never) as never;
    }
    async get(uri: string) {
      return this.raw.request({ method: "skills/get", params: { uri } } as never, z.looseObject({ skill: z.any() }) as never) as never;
    }
  }
  return async () => ({ SkillsClient }) as unknown as SkillsSdk;
}

async function rig(opts: { gateway?: GatewayOptions; declare?: Record<string, object>; upstreamExt?: boolean } = {}) {
  const seen: Array<{ kind: string; method?: string; principal?: unknown; partition?: unknown; meta?: Record<string, unknown> }> = [];
  const audit: CallAuditEntry[] = [];
  const record = authorize((req) => {
    seen.push({ kind: req.kind, method: (req as { method?: string }).method, principal: req.context?.meta?.principal, partition: req.context?.partition, meta: req.context?.meta });
    return "allow";
  });
  const a = new MockMCPServer(
    {
      tools: [{ name: "crunch", task: true, taskDelayMs: 30, handler: () => ({ content: [{ type: "text", text: "done" }] }) }],
      skills: [{ name: "only-a", description: "A only" }],
    },
    { era: "legacy" },
  );
  // A plain extension upstream for the pass-through handler.
  const calls: Array<Record<string, unknown>> = [];
  const ext = new Server({ name: "ext", version: "1" }, { capabilities: { tools: {}, extensions: { "x.test/events": { poll: true } } } as never });
  ext.setRequestHandler("tools/list", () => ({ tools: [] }));
  ext.setRequestHandler("events/poll" as never, { params: z.looseObject({}) } as never, ((p: Record<string, unknown>) => (calls.push(p), { events: ["e"] })) as never);
  const [ect, est] = InMemoryTransport.createLinkedPair();
  await ext.connect(est);

  const upstream = new MCPClient({
    servers: { a: { transport: a.transport }, e: { transport: () => ect as never } },
    skillsSdk: fakeSkillsSdk(),
    interceptors: [record],
    onCall: (e) => void audit.push(e),
  });
  await upstream.connect();
  const gateway = createGateway(upstream, {
    inboundAuth: true,
    audit: (e) => void audit.push(e),
    extensions: { passthrough: { "x.test/events": { methods: ["events/poll"] } } },
    ...opts.gateway,
  });
  let current: Auth = as("alice");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.connect(authed(st, () => current) as never);
  const consumer = new Client(
    { name: "consumer", version: "1" },
    { capabilities: { extensions: opts.declare ?? { [TASKS_EXT]: {}, [SKILLS_EXT]: {}, "x.test/events": {} } } as never },
  );
  await consumer.connect(ct);
  closers.push(async () => {
    await consumer.close();
    await gateway.close();
    await upstream.close();
    await a.close();
    await ext.close();
  });
  const req = (method: string, params: Record<string, unknown>) => consumer.request({ method, params } as never, loose as never) as Promise<Record<string, unknown>>;
  return { seen, audit, calls, as: (who: Auth) => void (current = who), req };
}

const SPOOF = { principal: "alice", partition: "alice", authScopes: ["admin"] };

describe("inbound auth: tasks", () => {
  it("tenant B, with A's task id AND a spoofed principal/partition, gets 'unknown task' on get, update and cancel", async () => {
    const { req, as: who, audit } = await rig();
    who(as("alice"));
    const created = await req("tools/call", { name: "a.crunch", arguments: {} });
    const id = String(created.taskId);
    expect(id).toMatch(/^gw1\./);

    who(as("bob"));
    for (const method of ["tasks/get", "tasks/cancel", "tasks/update"]) {
      await expect(req(method, { taskId: id, _meta: SPOOF })).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    }
    expect(audit.filter((e) => e.kind === "task" && e.outcome === "denied").length).toBeGreaterThanOrEqual(3);

    // The owner (verified alice) still reaches it, even with no claim of her own.
    who(as("alice"));
    let status = "";
    for (let i = 0; i < 100 && status !== "completed"; i++) {
      status = String((await req("tasks/get", { taskId: id })).status);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(status).toBe("completed");
  });

  it("a task created under one verified principal is not minted for the claimed one", async () => {
    const { req, as: who } = await rig();
    who(as("bob"));
    // Bob claims to be alice at creation; the id is bound to the VERIFIED principal (bob), so alice cannot... and bob can.
    const created = await req("tools/call", { name: "a.crunch", arguments: {}, _meta: SPOOF });
    const id = String(created.taskId);
    who(as("alice"));
    await expect(req("tasks/get", { taskId: id, _meta: SPOOF })).rejects.toMatchObject({ message: expect.stringContaining("unknown task") });
    who(as("bob"));
    expect((await req("tasks/get", { taskId: id })).taskId).toBe(id);
  });
});

describe("inbound auth: skills and extension pass-through", () => {
  it("skills/list and skills/get run under the verified principal and partition; a spoofed claim is dropped", async () => {
    const { req, seen, as: who } = await rig();
    who(as("bob"));
    await req("skills/list", { _meta: SPOOF });
    const list = seen.filter((s) => s.kind === "skill");
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s.principal).toBe("bob");
      expect(s.partition).toBe("bob");
      expect(s.meta?.authScopes).toEqual(["mcp"]); // not the claimed ["admin"]
    }
    seen.length = 0;
    await req("skills/get", { uri: "skill://a/only-a/SKILL.md", _meta: SPOOF });
    const get = seen.filter((s) => s.kind === "skill");
    expect(get.length).toBeGreaterThan(0);
    expect(get.every((s) => s.principal === "bob" && s.partition === "bob")).toBe(true);
  });

  it("extension pass-through sees the verified principal, not the claim", async () => {
    const { req, seen, as: who } = await rig();
    who(as("bob"));
    await req("events/poll", { since: 1, _meta: SPOOF });
    const ext = seen.filter((s) => s.kind === "extension");
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ principal: "bob", partition: "bob" });
    expect(ext[0]!.meta?.authScopes).toEqual(["mcp"]);
  });

  it("with no verified token, a claimed principal/partition is stripped everywhere (and `required` refuses outright)", async () => {
    const open = await rig();
    open.as(undefined);
    await open.req("events/poll", { since: 1, _meta: SPOOF });
    const ext = open.seen.find((s) => s.kind === "extension")!;
    expect(ext.principal).toBeUndefined();
    expect(ext.partition).toBeUndefined();

    const strict = await rig({ gateway: { inboundAuth: { required: true } } });
    strict.as(undefined);
    await expect(strict.req("skills/list", {})).rejects.toMatchObject({ message: expect.stringMatching(/verified bearer token/) });
    await expect(strict.req("tools/call", { name: "a.crunch", arguments: {} })).rejects.toBeTruthy();
  });

  it("tools/call: principal and partition are the verified ones", async () => {
    const { req, seen, as: who } = await rig({ declare: {} });
    who(as("bob"));
    await req("tools/call", { name: "a.crunch", arguments: {}, _meta: SPOOF });
    const call = seen.find((s) => s.kind === "call")!;
    // (the gateway hands the partition on in `_meta.partition`; mcp-gate's partitionFrom turns it into context.partition)
    expect(call).toMatchObject({ principal: "bob" });
    expect(call.meta).toMatchObject({ partition: "bob", authScopes: ["mcp"] });
  });
});
