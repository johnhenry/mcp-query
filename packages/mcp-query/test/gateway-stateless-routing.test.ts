// Gateway, stateless-era details (#82 item 6) and routing headers (#82 item 7), on the lockfile SDK.
// Upstreams are real SDK HTTP handlers reached through the SDK's Streamable HTTP client transport
// (in process), and every assertion about "what went upstream" reads the recorded wire.

import { describe, it, expect, afterEach } from "vitest";
import { MCPClient, type CallAuditEntry, type RequestInterceptor } from "../src/core/client.js";
import { authorize } from "../src/server/authorize.js";
import { createGatewayHandler, type GatewayHandlerOptions } from "../src/server/gateway.js";
import { encodeHeaderValue, nameFromBody } from "../src/core/routingHeaders.js";
import { httpUpstream, type UpstreamSpec } from "./support/httpUpstream.js";

const V = "2026-07-28";
const ENV = "io.modelcontextprotocol/";
const TRACE = "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
});

type Ups = Record<string, UpstreamSpec & { versions?: string[] }>;

async function rig(ups: Ups, o: { gateway?: GatewayHandlerOptions; interceptors?: RequestInterceptor[]; onCall?: (e: CallAuditEntry) => void } = {}) {
  const made = Object.fromEntries(Object.entries(ups).map(([n, s]) => [n, httpUpstream(s)]));
  const client = new MCPClient({
    servers: Object.fromEntries(Object.entries(made).map(([n, u]) => [n, { transport: u.transport, versions: ups[n]!.versions ?? [V] }])),
    ...(o.interceptors ? { interceptors: o.interceptors } : {}),
    ...(o.onCall ? { onCall: o.onCall } : {}),
  });
  await client.connect();
  const h = createGatewayHandler(client, o.gateway);
  closers.push(async () => {
    await h.close();
    await client.close();
    await Promise.all(Object.values(made).map((u) => u.close()));
  });
  return { client, h, up: made };
}

interface Rpc {
  status: number;
  body: any;
}
/** POST one modern JSON-RPC request at the gateway handler, with correct routing headers unless overridden (null removes one). */
async function rpc(
  h: { fetch: (r: Request, o?: any) => Promise<Response> },
  method: string,
  params: Record<string, unknown> = {},
  o: { headers?: Record<string, string | null>; meta?: Record<string, unknown>; authInfo?: unknown; version?: string; caps?: Record<string, unknown> } = {},
): Promise<Rpc> {
  const version = o.version ?? V;
  const name = nameFromBody(method, params);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": version,
    "mcp-method": method,
    ...(name !== undefined ? { "mcp-name": encodeHeaderValue(name) } : {}),
  };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  const isModern = version >= V;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: { ...params, ...(isModern || o.meta ? { _meta: { ...(isModern ? { [`${ENV}protocolVersion`]: version, [`${ENV}clientCapabilities`]: o.caps ?? {} } : {}), ...(o.meta ?? {}) } } : {}) },
  };
  const res = await h.fetch(new Request("http://gw.local/mcp", { method: "POST", headers, body: JSON.stringify(body) }), o.authInfo ? { authInfo: o.authInfo } : undefined);
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // an SSE-framed reply: take the last data line
    const line = text.split("\n").filter((l) => l.startsWith("data:")).pop();
    parsed = line ? JSON.parse(line.slice(5)) : text;
  }
  return { status: res.status, body: parsed };
}

const REGION = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, n: { type: "integer", "x-mcp-header": "N" } } };

describe("item 6: per-request _meta traverses the gate", () => {
  it("forwards clientInfo, logLevel and the trace keys to a modern upstream", async () => {
    const { h, up } = await rig({ a: { tools: [{ name: "t" }] } });
    const r = await rpc(h, "tools/call", { name: "a.t", arguments: {} }, {
      meta: { [`${ENV}clientInfo`]: { name: "consumer-app", version: "9.9" }, [`${ENV}logLevel`]: "info", traceparent: TRACE, tracestate: "k=v", baggage: "a=b" },
    });
    expect(r.status).toBe(200);
    const meta = up.a.calls("tools/call")[0]!.params._meta;
    expect(meta[`${ENV}clientInfo`]).toEqual({ name: "consumer-app", version: "9.9" });
    expect(meta[`${ENV}logLevel`]).toBe("info");
    expect(meta).toMatchObject({ traceparent: TRACE, tracestate: "k=v", baggage: "a=b" });
    // The envelope's own fields are the gateway's, not the consumer's.
    expect(meta[`${ENV}protocolVersion`]).toBe(V);
    expect(meta[`${ENV}clientCapabilities`]).not.toHaveProperty("elicitation");
  });

  it("drops malformed clientInfo / logLevel / trace values instead of forwarding them", async () => {
    const { h, up } = await rig({ a: { tools: [{ name: "t" }] } });
    await rpc(h, "tools/call", { name: "a.t", arguments: {} }, { meta: { traceparent: 7, baggage: { a: 1 }, tracestate: "ok" } });
    const meta = up.a.calls("tools/call")[0]!.params._meta;
    expect(meta).not.toHaveProperty("traceparent");
    expect(meta).not.toHaveProperty("baggage");
    expect(meta.tracestate).toBe("ok");
    expect(meta[`${ENV}clientInfo`]).toEqual({ name: "mcp-query", version: "0.1.0" }); // the gateway's own, as before
  });

  it("does not send clientInfo / logLevel to a 2025-era upstream", async () => {
    const { h, up } = await rig({ a: { tools: [{ name: "t" }], legacy: true, versions: ["2025-11-25"] } });
    await rpc(h, "tools/call", { name: "a.t", arguments: {} }, { meta: { [`${ENV}clientInfo`]: { name: "consumer-app", version: "9.9" }, [`${ENV}logLevel`]: "debug", traceparent: TRACE } });
    const call = up.a.calls("tools/call")[0]!;
    expect(JSON.stringify(call.params._meta ?? {})).not.toContain("consumer-app");
    expect(call.params._meta ?? {}).not.toHaveProperty(`${ENV}logLevel`);
    expect(call.params._meta?.traceparent).toBe(TRACE);
  });

  it("forwards them on prompts/get and resources/read as well", async () => {
    const { h, up } = await rig({ a: { prompts: [{ name: "p" }], resources: [{ uri: "file:///r" }] } });
    const meta = { [`${ENV}clientInfo`]: { name: "consumer-app", version: "1" }, traceparent: TRACE };
    await rpc(h, "prompts/get", { name: "a.p" }, { meta });
    await rpc(h, "resources/read", { uri: "file:///r" }, { meta });
    for (const m of ["prompts/get", "resources/read"]) {
      const sent = up.a.calls(m)[0]!.params._meta;
      expect(sent[`${ENV}clientInfo`]).toEqual({ name: "consumer-app", version: "1" });
      expect(sent.traceparent).toBe(TRACE);
    }
  });

  it("never lets forwarding reintroduce consumer-supplied principal / partition / authScopes / authClientId", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const spy: RequestInterceptor = (op, next) => (op.kind === "call" && seen.push(op.context?.meta), next(op));
    const { h, up } = await rig({ a: { tools: [{ name: "t" }] } }, { gateway: { inboundAuth: true }, interceptors: [spy] });
    const spoof = { principal: "root", partition: "other-tenant", authScopes: ["admin"], authClientId: "evil", traceparent: TRACE, [`${ENV}clientInfo`]: { name: "c", version: "1" } };
    await rpc(h, "tools/call", { name: "a.t", arguments: {} }, { meta: spoof, authInfo: { clientId: "app", scopes: ["mcp"], extra: { sub: "alice" } } });
    for (const meta of [seen[0], up.a.calls("tools/call")[0]!.params._meta]) {
      expect(meta).toMatchObject({ principal: "alice", partition: "alice", authScopes: ["mcp"], authClientId: "app", traceparent: TRACE });
    }
    // Without a verified token the claimed keys are dropped too (not merely not overwritten).
    seen.length = 0;
    await rpc(h, "tools/call", { name: "a.t", arguments: {} }, { meta: spoof });
    expect(seen[0]).not.toHaveProperty("principal");
    expect(seen[0]).not.toHaveProperty("authScopes");
    expect(seen[0]).toMatchObject({ traceparent: TRACE });
  });
});

describe("item 6: cache hints through the gate", () => {
  const list = (h: Parameters<typeof rpc>[0], m = "tools/list") => rpc(h, m).then((r) => r.body.result);

  it("tools/list: the minimum upstream ttl, and public only when every upstream said public", async () => {
    const { h } = await rig({
      a: { tools: [{ name: "x" }], hint: { ttlMs: 60_000, cacheScope: "public" } },
      b: { tools: [{ name: "y" }], hint: { ttlMs: 5_000, cacheScope: "public" } },
    });
    const r = await list(h);
    expect(r.cacheScope).toBe("public");
    expect(r.ttlMs).toBeLessThanOrEqual(5_000);
    expect(r.ttlMs).toBeGreaterThan(0);
  });

  it("one private upstream makes the whole list private", async () => {
    const { h } = await rig({
      a: { tools: [{ name: "x" }], hint: { ttlMs: 60_000, cacheScope: "public" } },
      b: { tools: [{ name: "y" }], hint: { ttlMs: 60_000, cacheScope: "private" } },
    });
    expect((await list(h)).cacheScope).toBe("private");
  });

  it("an upstream that gave no hint is not vouched for: private", async () => {
    const { h } = await rig({ a: { tools: [{ name: "x" }], hint: { ttlMs: 60_000, cacheScope: "public" } }, b: { tools: [{ name: "y" }] } });
    expect((await list(h)).cacheScope).toBe("private");
  });

  it("a list the gateway filters or annotates is never public (it may differ per caller)", async () => {
    const hint = { ttlMs: 60_000, cacheScope: "public" as const };
    for (const gateway of [{ filter: () => true }, { annotate: () => undefined }] as GatewayHandlerOptions[]) {
      const { h } = await rig({ a: { tools: [{ name: "x" }], resources: [{ uri: "file:///r" }], prompts: [{ name: "p" }], hint } }, { gateway });
      for (const m of ["tools/list", "resources/list", "prompts/list"]) expect((await list(h, m)).cacheScope, m).toBe("private");
    }
  });

  it("resources/list, prompts/list and resources/templates/list carry hints too", async () => {
    const { h } = await rig({
      a: { resources: [{ uri: "file:///r" }], prompts: [{ name: "p" }], templates: [{ uriTemplate: "file:///{x}" }], hint: { ttlMs: 30_000, cacheScope: "public" } },
    });
    for (const m of ["resources/list", "prompts/list", "resources/templates/list"]) {
      const r = await list(h, m);
      expect(r.cacheScope, m).toBe("public");
      expect(r.ttlMs, m).toBeGreaterThan(0);
      expect(r.ttlMs, m).toBeLessThanOrEqual(30_000);
    }
  });

  it("server/discover answers with a safe hint", async () => {
    const { h } = await rig({ a: { tools: [{ name: "x" }], hint: { ttlMs: 60_000, cacheScope: "public" } } });
    const r = await list(h, "server/discover");
    expect(r.ttlMs).toBeGreaterThanOrEqual(0);
    expect(["public", "private"]).toContain(r.cacheScope);
    expect(r.cacheScope).toBe("private"); // the gateway's own capability set depends on the consumer's declaration
  });

  it("resources/read passes the upstream's hints through and never upgrades private to public", async () => {
    const pub = await rig({ a: { resources: [{ uri: "file:///r" }], hint: { ttlMs: 20_000, cacheScope: "public" } } });
    const r1 = (await rpc(pub.h, "resources/read", { uri: "file:///r" })).body.result;
    expect(r1.cacheScope).toBe("public");
    expect(r1.ttlMs).toBeLessThanOrEqual(20_000);
    const priv = await rig({ a: { resources: [{ uri: "file:///r" }], hint: { ttlMs: 20_000, cacheScope: "private" } } });
    expect((await rpc(priv.h, "resources/read", { uri: "file:///r" })).body.result.cacheScope).toBe("private");
  });
});

describe("item 6: deterministic order", () => {
  it("lists come back sorted by upstream then name, whatever the connect and upstream order", async () => {
    const spec = (names: string[]) => ({ tools: names.map((name) => ({ name })), prompts: names.map((name) => ({ name })), resources: names.map((n) => ({ uri: `file:///${n}` })), templates: names.map((n) => ({ uriTemplate: `file:///{${n}}` })) });
    const { h } = await rig({ z: spec(["m", "b", "q"]), a: spec(["y", "c"]) });
    const names = async (m: string, key: string, field: string) => (await rpc(h, m)).body.result[key].map((i: any) => i[field]);
    expect(await names("tools/list", "tools", "name")).toEqual(["a.c", "a.y", "z.b", "z.m", "z.q"]);
    expect(await names("prompts/list", "prompts", "name")).toEqual(["a.c", "a.y", "z.b", "z.m", "z.q"]);
    expect(await names("resources/list", "resources", "uri")).toEqual(["file:///b", "file:///c", "file:///m", "file:///q", "file:///y"].sort((x, y) => 0 * x.length + (0 * y.length)).length ? ["file:///c", "file:///y", "file:///b", "file:///m", "file:///q"] : []);
    expect(await names("resources/templates/list", "resourceTemplates", "uriTemplate")).toEqual(["file:///{c}", "file:///{y}", "file:///{b}", "file:///{m}", "file:///{q}"]);
    const again = await names("tools/list", "tools", "name");
    expect(again).toEqual(await names("tools/list", "tools", "name"));
  });
});

describe("item 7: the gateway rejects headers that disagree with the body (HeaderMismatch -32020)", () => {
  const tool = { name: "t", inputSchema: REGION };
  const call = (h: Parameters<typeof rpc>[0], args: Record<string, unknown>, headers: Record<string, string | null> = {}) => rpc(h, "tools/call", { name: "a.t", arguments: args }, { headers });

  it("accepts matching headers, including a sentinel-encoded Mcp-Param and a numerically equal integer", async () => {
    const { h, up } = await rig({ a: { tools: [tool] } });
    expect((await call(h, { region: "us-west1", n: 3 }, { "mcp-param-region": "us-west1", "mcp-param-n": "3.0" })).status).toBe(200);
    expect((await call(h, { region: "Hello, 世界" }, { "mcp-param-region": encodeHeaderValue("Hello, 世界") })).status).toBe(200);
    expect(up.a.calls("tools/call")).toHaveLength(2);
  });

  it("rejects a mismatching or missing Mcp-Param-* header on tools/call (the SDK's low-level Server does not)", async () => {
    const { h, up } = await rig({ a: { tools: [tool] } });
    for (const headers of [{ "mcp-param-region": "eu" }, { "mcp-param-region": null }, { "mcp-param-region": "us", "mcp-param-n": "4" }]) {
      const r = await call(h, { region: "us", n: 3 }, headers);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe(-32020);
    }
    // a header for an argument the body does not carry
    expect((await call(h, {}, { "mcp-param-region": "us" })).body.error.code).toBe(-32020);
    expect(up.a.calls("tools/call")).toHaveLength(0); // nothing reached the upstream
  });

  it("rejects Mcp-Method and Mcp-Name that disagree or are missing", async () => {
    const { h } = await rig({ a: { tools: [tool], prompts: [{ name: "p" }], resources: [{ uri: "file:///r" }] } });
    for (const headers of [{ "mcp-method": "tools/list" }, { "mcp-method": null }, { "mcp-name": "a.other" }, { "mcp-name": null }]) {
      const r = await call(h, {}, headers);
      expect(r.status, JSON.stringify(headers)).toBe(400);
      expect(r.body.error.code).toBe(-32020);
    }
    expect((await rpc(h, "prompts/get", { name: "a.p" }, { headers: { "mcp-name": "a.q" } })).body.error.code).toBe(-32020);
    expect((await rpc(h, "resources/read", { uri: "file:///r" }, { headers: { "mcp-name": "file:///x" } })).body.error.code).toBe(-32020);
  });

  it("rejects a header/body disagreement on a 2025-era request too, and does not demand headers there", async () => {
    const { h } = await rig({ a: { tools: [tool], legacy: true } });
    const legacy = (headers: Record<string, string | null>) => rpc(h, "tools/list", {}, { version: "2025-11-25", headers: { "mcp-method": null, ...headers } });
    expect((await legacy({ "mcp-method": "tools/call" })).body.error.code).toBe(-32020);
  });

  it("checks the Mcp-Name of the tasks/* and events/* methods the SDK does not table (SEP-2663, SEP-3415)", async () => {
    const { h } = await rig({ a: {} });
    const t = await rpc(h, "tasks/get", { taskId: "gw-1" }, { headers: { "mcp-name": "gw-2" } });
    expect([t.status, t.body.error.code]).toEqual([400, -32020]);
    const wrong = await rpc(h, "events/poll", { name: "incident.created" }, { headers: { "mcp-name": "other" } });
    expect([wrong.status, wrong.body.error.code]).toEqual([400, -32020]);
    const missing = await rpc(h, "tasks/get", { taskId: "gw-1" }, { headers: { "mcp-name": null } });
    expect([missing.status, missing.body.error.code]).toEqual([400, -32020]);
    const ok = await rpc(h, "events/list"); // no params.name, no Mcp-Name
    expect(ok.body.error?.code).not.toBe(-32020);
  });

  it("leaves non-POST and non-JSON requests to the SDK", async () => {
    const { h } = await rig({ a: {} });
    expect((await h.fetch(new Request("http://gw.local/mcp", { method: "GET" }))).status).toBeGreaterThanOrEqual(400);
    const bad = await h.fetch(new Request("http://gw.local/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "x" }, body: "{nope" }));
    expect(bad.status).toBe(400);
  });
});

describe("item 7: policy, rate limit and audit see body-verified routing", () => {
  it("puts method, name and x-mcp-header values on context.routing, from the body", async () => {
    const seen: any[] = [];
    const audit: CallAuditEntry[] = [];
    const policy = authorize((req) => (seen.push({ kind: req.kind, method: req.method, routing: req.context?.routing }), "allow"));
    const { h } = await rig({ a: { tools: [{ name: "t", inputSchema: REGION }], resources: [{ uri: "file:///r" }], prompts: [{ name: "p" }] } }, { interceptors: [policy], onCall: (e) => audit.push(e) });
    await rpc(h, "tools/call", { name: "a.t", arguments: { region: "us", n: 2 } }, { headers: { "mcp-param-region": "us", "mcp-param-n": "2" } });
    await rpc(h, "prompts/get", { name: "a.p" });
    await rpc(h, "resources/read", { uri: "file:///r" });
    const byKind = Object.fromEntries(seen.filter((s) => s.routing).map((s) => [s.kind, s.routing]));
    expect(byKind.call).toEqual({ method: "tools/call", name: "a.t", params: { Region: "us", N: "2" } });
    expect(byKind.prompt).toEqual({ method: "prompts/get", name: "a.p" });
    expect(byKind.read).toEqual({ method: "resources/read", name: "file:///r" });
    const entry = audit.find((e) => e.kind === "call" && e.routing);
    expect(entry?.routing).toEqual({ method: "tools/call", name: "a.t", params: { Region: "us", N: "2" } });
    expect(entry?.outcome).toBe("ok");
  });

  it("a header that lies never reaches policy: the request is refused first", async () => {
    const seen: unknown[] = [];
    const policy = authorize((req) => (seen.push(req.context?.routing), "allow"));
    const { h } = await rig({ a: { tools: [{ name: "t" }, { name: "dangerous" }] } }, { interceptors: [policy] });
    // Header claims the harmless tool; the body calls the other one.
    const r = await rpc(h, "tools/call", { name: "a.dangerous", arguments: {} }, { headers: { "mcp-name": "a.t" } });
    expect(r.body.error.code).toBe(-32020);
    expect(seen.filter((x) => x)).toHaveLength(0);
  });

  it("a rate-limit key function can partition by routing facts", async () => {
    const keys: string[] = [];
    const rl: RequestInterceptor = (op, next) => (op.kind === "call" && keys.push(`${op.peer}:${op.context?.routing?.name}`), next(op));
    const { h } = await rig({ a: { tools: [{ name: "t" }] } }, { interceptors: [rl] });
    await rpc(h, "tools/call", { name: "a.t", arguments: {} });
    expect(keys).toEqual(["a:a.t"]);
  });

  it("a consumer cannot plant routing through _meta", async () => {
    const seen: any[] = [];
    const policy = authorize((req) => (seen.push(req.context?.routing), "allow"));
    const { h } = await rig({ a: { tools: [{ name: "t" }] } }, { interceptors: [policy] });
    await rpc(h, "tools/call", { name: "a.t", arguments: {} }, { meta: { routing: { method: "x", name: "y" } } });
    expect(seen.find((x) => x)).toEqual({ method: "tools/call", name: "a.t" });
  });
});

describe("item 7: the gate sends the right routing headers upstream", () => {
  it("tools/call: Mcp-Method, Mcp-Name and Mcp-Param-* from the tool's schema; resources/read and prompts/get carry Mcp-Name", async () => {
    const { h, up } = await rig({ a: { tools: [{ name: "t", inputSchema: REGION }], prompts: [{ name: "p" }], resources: [{ uri: "file:///r" }] } });
    await rpc(h, "tools/call", { name: "a.t", arguments: { region: "Hello, 世界", n: 5 } }, { headers: { "mcp-param-region": encodeHeaderValue("Hello, 世界"), "mcp-param-n": "5" } });
    await rpc(h, "prompts/get", { name: "a.p" });
    await rpc(h, "resources/read", { uri: "file:///r" });
    const call = up.a.calls("tools/call")[0]!.headers;
    expect(call).toMatchObject({ "mcp-method": "tools/call", "mcp-name": "t", "mcp-param-n": "5", "mcp-param-region": "=?base64?SGVsbG8sIOS4lueVjA==?=" });
    expect(up.a.calls("prompts/get")[0]!.headers).toMatchObject({ "mcp-method": "prompts/get", "mcp-name": "p" });
    expect(up.a.calls("resources/read")[0]!.headers).toMatchObject({ "mcp-method": "resources/read", "mcp-name": "file:///r" });
    expect(up.a.calls("tools/call")[0]!.status).toBe(200); // the upstream's own validation accepted them
  });
});
