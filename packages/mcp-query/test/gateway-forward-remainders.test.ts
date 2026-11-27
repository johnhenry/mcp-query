// #82 remainders: forwarding for resources/read, relaying a 2025-era upstream's elicitation to a
// consumer of either era, and inbound auth on subscriptions/listen.
import { describe, it, expect, vi } from "vitest";
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCPClient, type CallAuditEntry } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGateway, createGatewayHandler, type GatewayOptions } from "../src/server/gateway.js";
import { InteractionRelay } from "../src/server/interactionRelay.js";
import { AuthorizationError } from "../src/server/authorize.js";

vi.setConfig({ testTimeout: 60_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("condition not met");
    await sleep(5);
  }
}
type Auth = { clientId: string; scopes: string[]; extra: { sub: string } } | undefined;
const as = (sub: string): Auth => ({ clientId: "app", scopes: ["mcp"], extra: { sub } });
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

function handlerTransport(handler: { fetch: (r: Request, o?: { authInfo?: unknown }) => Promise<Response> }, auth?: () => Auth, wire?: { sent: string[]; received: string[] }) {
  return new StreamableHTTPClientTransport(new URL("http://gw.local/mcp"), {
    fetch: async (url, init) => {
      if (wire && typeof init?.body === "string") wire.sent.push(init.body);
      const a = auth?.();
      const res = await handler.fetch(new Request(url, init), a ? { authInfo: a } : undefined);
      if (wire) void res.clone().text().then((t) => wire.received.push(t), () => {});
      return res;
    },
  });
}

const ask = (extra: Record<string, unknown> = {}) => ({
  name: "ask",
  handler: async (_a: Record<string, unknown>, ctx: { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> }) => {
    const r = await ctx.elicit({ message: "Pick a colour", requestedSchema: { type: "object", properties: { colour: { type: "string" } } }, ...extra });
    return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] };
  },
});

// ── 1. resources/read, modern upstream ───────────────────────────────────────────────────────────
describe("forward: resources/read (modern upstream)", () => {
  async function rig(gw: GatewayOptions = {}) {
    const audit: CallAuditEntry[] = [];
    const up = new MockMCPServer({
      resources: [{ uri: "file:///secret", name: "secret", read: async ({ elicit }) => { const r = await elicit({ message: "Which?", requestedSchema: { type: "object", properties: { k: { type: "string" } } } }); return { text: `got ${JSON.stringify(r.content)}` }; } }],
    });
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, versions: ["2026-07-28"], onCall: (e) => void audit.push(e) });
    await upstream.connect();
    const handler = createGatewayHandler(upstream, { interactions: "forward", ...gw });
    const asked: unknown[] = [];
    const wire = { sent: [] as string[], received: [] as string[] };
    const consumer = new MCPClient({
      servers: { gw: { transport: () => handlerTransport(handler, undefined, wire) } },
      versions: ["2026-07-28"],
      handlers: { elicitation: async (r: unknown) => (asked.push(r), { action: "accept", content: { k: "v" } }) },
    });
    await consumer.connect();
    const stop = async () => { await consumer.close(); await handler.close(); await upstream.close(); await up.close(); };
    return { consumer, upstream, asked, audit, wire, stop };
  }

  it("the consumer answers a read's elicitation; requestState verbatim; both hops audited; never cached", async () => {
    const { consumer, upstream, asked, audit, wire, stop } = await rig();
    const r = (await consumer.readResource("file:///secret")) as { contents: { text: string }[] };
    expect(r.contents[0]!.text).toBe('got {"k":"v"}');
    expect(asked).toHaveLength(1);
    const interim = wire.received.map((b) => b.match(/"requestState":"([^"]*)"/)?.[1]).find(Boolean);
    expect(interim).toMatch(/^replay-\d+$/);
    expect(wire.sent.find((b) => b.includes("inputResponses"))).toContain(`"requestState":"${interim}"`);
    const reads = audit.filter((e) => e.kind === "read" && e.interaction);
    expect(reads.map((e) => e.interaction!.phase)).toEqual(["request", "response"]);
    expect(upstream.cache.getSnapshot({ kind: "resource", server: "a", uri: "file:///secret" })?.status).not.toBe("success");
    await stop();
  });

  it("denies a URL-host / answer guard the same way as a tool: guardAnswers can decline the answer", async () => {
    const { consumer, stop } = await rig({ guardAnswers: ({ inputResponses }) => ({ inputResponses: Object.fromEntries(Object.keys(inputResponses).map((k) => [k, { action: "decline" }])), declined: Object.keys(inputResponses) }) });
    const r = (await consumer.readResource("file:///secret")) as { contents: { text: string }[] };
    expect(r.contents[0]!.text).toBe("got undefined");
    await stop();
  });
});

// ── 2/3. legacy upstream, both consumer eras ─────────────────────────────────────────────────────
async function legacyRig(opts: { gw?: GatewayOptions; relayMs?: number; tools?: ReturnType<typeof ask>[] } = {}) {
  const audit: CallAuditEntry[] = [];
  const gateAudit: CallAuditEntry[] = [];
  const up = new MockMCPServer({
    tools: opts.tools ?? [ask(), { name: "other", handler: () => ({ content: [{ type: "text", text: "other-ok" }] }) }],
    resources: [{ uri: "file:///r", name: "r", read: async ({ elicit }) => { const r = await elicit({ message: "Which?", requestedSchema: { type: "object", properties: {} } }); return { text: `read ${r.action}` }; } }],
  });
  const relay = new InteractionRelay({ timeoutMs: opts.relayMs });
  const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, interactions: relay, onCall: (e) => void audit.push(e) });
  await upstream.connect();
  expect(upstream.connection("a")!.era).toBe("legacy");
  const gwOpts: GatewayOptions = { interactions: "forward", audit: (e) => void gateAudit.push(e), ...opts.gw };
  return { up, upstream, relay, audit, gateAudit, gwOpts };
}

describe("forward: 2025-era upstream, modern consumer", () => {
  it("relays the upstream's elicitation as an input_required round and returns the answer upstream", async () => {
    const r = await legacyRig();
    const handler = createGatewayHandler(r.upstream, r.gwOpts);
    const asked: Array<Record<string, unknown>> = [];
    const wire = { sent: [] as string[], received: [] as string[] };
    const consumer = new MCPClient({
      servers: { gw: { transport: () => handlerTransport(handler, undefined, wire) } },
      versions: ["2026-07-28"],
      handlers: { elicitation: async (q: unknown) => (asked.push(q as Record<string, unknown>), { action: "accept", content: { colour: "red" } }) },
    });
    await consumer.connect();
    expect(text(await consumer.callTool("gw.a.ask", {}))).toBe('accept:{"colour":"red"}');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ message: "Pick a colour" });
    expect(wire.received.join("")).toContain("input_required");
    // Hops audited: the gate's round (request), the consumer's answer (response); the call itself once.
    expect(r.gateAudit.map((e) => e.interaction?.phase)).toEqual(["request", "response"]);
    expect(r.gateAudit[0]!.interaction!.methods).toEqual(["elicitation/create"]);
    expect(r.audit.filter((e) => e.kind === "call")).toHaveLength(1);
    expect(r.relay.pendingAsks).toBe(0);
    // reads and a second call on the same upstream work afterwards (lock released)
    expect(text(await consumer.callTool("gw.a.other", {}))).toBe("other-ok");
    const rd = (await consumer.readResource("file:///r")) as { contents: { text: string }[] };
    expect(rd.contents[0]!.text).toBe("read accept");
    await consumer.close(); await handler.close(); await r.upstream.close(); await r.up.close();
  });

  it("runs the request guard (redaction / refusal) and the answer guard on the way back", async () => {
    const seenAnswers: unknown[] = [];
    const r = await legacyRig({
      gw: {
        guardInputRequests: (q) => {
          const [k, v] = Object.entries(q.inputRequests)[0]!;
          return { inputRequests: { [k]: { ...v, params: { ...v.params, message: "[redacted]" } } } };
        },
        guardAnswers: (q) => (seenAnswers.push(q.inputResponses), { inputResponses: Object.fromEntries(Object.keys(q.inputResponses).map((k) => [k, { action: "accept", content: { colour: "scrubbed" } }])), redactedFields: ["elicitation-1.content.colour"] }),
      },
    });
    const handler = createGatewayHandler(r.upstream, r.gwOpts);
    const asked: Array<Record<string, unknown>> = [];
    const consumer = new MCPClient({ servers: { gw: { transport: () => handlerTransport(handler) } }, versions: ["2026-07-28"], handlers: { elicitation: async (q: unknown) => (asked.push(q as Record<string, unknown>), { action: "accept", content: { colour: "red" } }) } });
    await consumer.connect();
    expect(text(await consumer.callTool("gw.a.ask", {}))).toBe('accept:{"colour":"scrubbed"}');
    expect(asked[0]!.message).toBe("[redacted]");
    expect(seenAnswers).toHaveLength(1);
    expect(r.gateAudit.find((e) => e.interaction?.phase === "response")!.interaction!.redactedFields).toEqual(["elicitation-1.content.colour"]);
    await consumer.close(); await handler.close(); await r.upstream.close(); await r.up.close();
  });

  it("a refused request (guard throws) cancels the upstream's ask and fails the call with -32003, audited denied", async () => {
    const r = await legacyRig({ gw: { guardInputRequests: () => { throw new AuthorizationError("denied: no"); } } });
    const handler = createGatewayHandler(r.upstream, r.gwOpts);
    const consumer = new MCPClient({ servers: { gw: { transport: () => handlerTransport(handler) } }, versions: ["2026-07-28"], handlers: { elicitation: async () => ({ action: "accept", content: {} }) } });
    await consumer.connect();
    await expect(consumer.callTool("gw.a.ask", {})).rejects.toMatchObject({ code: -32003 });
    expect(r.gateAudit.at(-1)!.outcome).toBe("denied");
    await until(() => r.audit.some((e) => e.kind === "call")); // the upstream call ran out
    expect(r.relay.pendingAsks).toBe(0);
    expect(text(await consumer.callTool("gw.a.other", {}))).toBe("other-ok"); // lock released
    await consumer.close(); await handler.close(); await r.upstream.close(); await r.up.close();
  });

  it("a consumer without the elicitation capability: the upstream's request is refused with a clear error, no hang", async () => {
    const r = await legacyRig();
    const handler = createGatewayHandler(r.upstream, r.gwOpts);
    const consumer = new MCPClient({ servers: { gw: { transport: () => handlerTransport(handler) } }, versions: ["2026-07-28"] });
    await consumer.connect();
    const out = (await consumer.callTool("gw.a.ask", {}).catch((e) => ({ err: String(e.message) }))) as { content?: { text: string }[]; isError?: boolean; err?: string };
    expect(JSON.stringify(out)).toMatch(/did not declare the elicitation capability|refused/);
    expect(r.relay.pendingAsks).toBe(0);
    await consumer.close(); await handler.close(); await r.upstream.close(); await r.up.close();
  });

  it("without an InteractionRelay on the client it fails closed with a clear error", async () => {
    const up = new MockMCPServer({ tools: [ask()] });
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } } });
    await upstream.connect();
    const handler = createGatewayHandler(upstream, { interactions: "forward" });
    const consumer = new MCPClient({ servers: { gw: { transport: () => handlerTransport(handler) } }, versions: ["2026-07-28"], handlers: { elicitation: async () => ({ action: "accept", content: {} }) } });
    await consumer.connect();
    await expect(consumer.callTool("gw.a.ask", {})).rejects.toMatchObject({ code: -32004, message: expect.stringContaining("InteractionRelay") });
    await consumer.close(); await handler.close(); await upstream.close(); await up.close();
  });

  it("cross-tenant: another principal cannot answer a pending ask, and the owner still can", async () => {
    const r = await legacyRig();
    const handler = createGatewayHandler(r.upstream, { ...r.gwOpts, inboundAuth: { required: true } });
    let state = "";
    const wire = { sent: [] as string[], received: [] as string[] };
    // Alice's consumer never answers: it records the round and returns decline-less cancel after we probe.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const alice = new MCPClient({
      servers: { gw: { transport: () => handlerTransport(handler, () => as("alice"), wire) } },
      versions: ["2026-07-28"],
      handlers: { elicitation: async () => { await gate; return { action: "accept", content: { colour: "blue" } }; } },
    });
    await alice.connect();
    const call = alice.callTool("gw.a.ask", {});
    await until(() => r.relay.pendingAsks === 1);
    await until(() => wire.received.some((b) => /"requestState":"/.test(b)));
    state = wire.received.map((b) => b.match(/"requestState":"([^"]*)"/)?.[1]).find(Boolean)!;
    // Bob replays Alice's state, with an answer, on the same tool.
    const probe = async (who: string | undefined) => {
      const body = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "a.ask", arguments: {}, requestState: state, inputResponses: { "elicitation-1": { action: "accept", content: { colour: "stolen" } } }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } } } };
      const res = await handler.fetch(
        new Request("http://gw.local/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "a.ask" }, body: JSON.stringify(body) }),
        who ? { authInfo: as(who) as never } : undefined,
      );
      return res.text();
    };
    expect(await probe("bob")).toMatch(/Invalid or expired requestState/);
    expect(await probe(undefined)).toMatch(/-32003|requires a verified bearer/);
    expect(r.relay.pendingAsks).toBe(1); // Alice's ask was neither consumed nor cancelled by the probes
    release();
    expect(text(await call)).toBe('accept:{"colour":"blue"}');
    await alice.close(); await handler.close(); await r.upstream.close(); await r.up.close();
  });
});

describe("forward: 2025-era upstream, 2025-era consumer", () => {
  it("the consumer's server-initiated elicitation/create answers the upstream's", async () => {
    const r = await legacyRig();
    const gateway = createGateway(r.upstream, r.gwOpts);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const asked: unknown[] = [];
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    consumer.setRequestHandler("elicitation/create", async (q) => (asked.push(q.params), { action: "accept", content: { colour: "green" } }));
    await consumer.connect(ct);
    expect(text(await consumer.callTool({ name: "a.ask", arguments: {} }))).toBe('accept:{"colour":"green"}');
    expect(asked).toHaveLength(1);
    expect(r.gateAudit.map((e) => e.interaction?.phase)).toEqual(["request", "response"]);
    await consumer.close(); await r.upstream.close(); await r.up.close();
  });

  it("a 2025-era consumer that declared no elicitation gets a clear refusal, not a hang", async () => {
    const r = await legacyRig();
    const gateway = createGateway(r.upstream, r.gwOpts);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: {} });
    await consumer.connect(ct);
    const out = await consumer.callTool({ name: "a.ask", arguments: {} }).catch((e) => ({ err: String(e.message) }));
    expect(JSON.stringify(out)).toMatch(/did not declare the elicitation capability|refused|did not declare/);
    await consumer.close(); await r.upstream.close(); await r.up.close();
  });
});

describe("InteractionRelay", () => {
  const expect_ = { server: "a", surface: "tool", target: "ask" } as const;
  it("declines when the consumer never answers, then the state is spent", async () => {
    const relay = new InteractionRelay({ timeoutMs: 40 });
    let expired = 0;
    let upstreamAnswer: unknown;
    const step = await relay.begin(
      { ...expect_, args: {}, who: { principal: "p" }, accepts: () => true, onExpire: () => void expired++ },
      async () => { upstreamAnswer = await relay.handleElicitation("a", { message: "x", requestedSchema: { type: "object", properties: {} } } as never); return "finished"; },
    );
    expect(step.kind).toBe("ask");
    await until(() => upstreamAnswer !== undefined);
    expect(upstreamAnswer).toEqual({ action: "decline" });
    expect(expired).toBe(1);
    if (step.kind === "ask") expect(() => relay.inspect(step.state, { principal: "p" }, expect_)).toThrow(/Invalid or expired/);
  });
  it("binds the state to identity, surface and target; a wrong probe does not consume it", async () => {
    const relay = new InteractionRelay({ timeoutMs: 5000 });
    const step = await relay.begin(
      { ...expect_, args: {}, who: { principal: "p", partition: "t1" }, accepts: () => true },
      async () => ((await relay.handleElicitation("a", { message: "x", requestedSchema: { type: "object", properties: {} } } as never)) as { action: string }).action,
    );
    if (step.kind !== "ask") throw new Error("expected ask");
    for (const bad of [{ principal: "q", partition: "t1" }, { principal: "p", partition: "t2" }, { principal: "p" }, {}]) expect(() => relay.inspect(step.state, bad, expect_)).toThrow(/Invalid or expired/);
    expect(() => relay.inspect(step.state, { principal: "p", partition: "t1" }, { ...expect_, target: "other" })).toThrow(/Invalid or expired/);
    const done = await relay.resume<string>(step.state, { principal: "p", partition: "t1" }, expect_, { [step.key]: { action: "accept", content: {} } });
    expect(done).toEqual({ kind: "done", value: "accept" });
    await expect(relay.resume(step.state, { principal: "p", partition: "t1" }, expect_, {})).rejects.toThrow(/Invalid or expired/); // one use
  });
  it("refuses an elicitation with no call in flight", async () => {
    await expect(new InteractionRelay().handleElicitation("a", { message: "x" } as never)).rejects.toMatchObject({ code: -32600 });
  });
  it("serializes calls per upstream and caps the pending count", async () => {
    const relay = new InteractionRelay({ maxPending: 2 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const mk = (t: string) => relay.begin({ ...expect_, target: t, args: {}, who: {}, accepts: () => true }, async () => { order.push(`start ${t}`); await hold; order.push(`end ${t}`); return t; });
    const p1 = mk("one");
    const p2 = mk("two");
    await expect(mk("three")).rejects.toMatchObject({ code: -32603 });
    await sleep(20);
    expect(order).toEqual(["start one"]); // two waits its turn
    release();
    expect(await p1).toEqual({ kind: "done", value: "one" });
    expect(await p2).toEqual({ kind: "done", value: "two" });
  });
});

// ── 3. inbound auth and subscriptions/listen ─────────────────────────────────────────────────────
describe("inbound auth: subscriptions/listen", () => {
  const listenReq = () =>
    new Request("http://gw.local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }),
    });
  async function base(gw: GatewayOptions) {
    const up = new MockMCPServer({ tools: [{ name: "pub" }] });
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } } });
    await upstream.connect();
    const handler = createGatewayHandler(upstream, gw);
    return { up, upstream, handler, stop: async () => { await handler.close(); await upstream.close(); await up.close(); } };
  }
  it("required: an unauthenticated listen is refused (401); an authenticated one opens", async () => {
    const { handler, stop } = await base({ inboundAuth: { required: true } });
    const denied = await handler.fetch(listenReq());
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: { code: number } }).error.code).toBe(-32003);
    const ok = await handler.fetch(listenReq(), { authInfo: as("alice") as never });
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    await stop();
  });
  it("not required: an unauthenticated listen still opens (unchanged)", async () => {
    const { handler, stop } = await base({ inboundAuth: true });
    const ok = await handler.fetch(listenReq());
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    await stop();
  });
  it("a tool the gateway hides being added upstream sends no list_changed to anyone; a visible one does", async () => {
    const { up, handler, stop } = await base({ inboundAuth: { required: true }, filter: (_s, _k, name) => !name.startsWith("secret") });
    const res = await handler.fetch(listenReq(), { authInfo: as("alice") as never });
    let seen = "";
    const reader = res.body!.getReader();
    void (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; seen += new TextDecoder().decode(value); } })();
    await until(() => seen.includes("acknowledged"));
    up.spec.tools = [{ name: "pub" }, { name: "secret-x" }];
    await up.notifyToolListChanged();
    await sleep(150);
    expect(seen).not.toContain("tools/list_changed");
    up.spec.tools = [{ name: "pub" }, { name: "secret-x" }, { name: "pub2" }];
    await up.notifyToolListChanged();
    await until(() => seen.includes("tools/list_changed"));
    await reader.cancel();
    await stop();
  });
});
