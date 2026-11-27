import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { run } from "../src/cli.js";
import { lintContract } from "../src/lint.js";
import { LIVE_RULES, runDisconnectedProbes, runProbes, type ProbeClient } from "../src/probes.js";

type Fake = Partial<ProbeClient> & { caps?: Record<string, unknown> };
function fake(f: Fake): ProbeClient {
  return {
    getServerCapabilities: () => f.caps ?? { tools: {}, resources: {} },
    getProtocolEra: () => "modern",
    getDiscoverResult: () => ({ supportedVersions: ["2026-07-28"] }),
    discover: async () => ({ supportedVersions: ["2026-07-28"] }),
    listTools: async () => ({ tools: [{ name: "a" }, { name: "b" }] }),
    readResource: async () => {
      throw Object.assign(new Error("not found"), { code: -32602 });
    },
    ...f,
  };
}
const findings = async (c: ProbeClient, rule: string) => (await runProbes(c)).filter((f) => f.rule === rule);

describe("live probe rules", () => {
  it("are separate from contract rules: lintContract never reports them", () => {
    const ids = new Set(LIVE_RULES.map((r) => r.id));
    expect(ids).toEqual(new Set(["stateless-ready", "deterministic-list-order", "resource-not-found-code", "reserved-error-range", "sse-only-transport", "server-card"]));
    const result = lintContract({ version: 2, tools: [], resources: [], templates: [], prompts: [] });
    expect(result.findings.some((f) => ids.has(f.rule))).toBe(false);
    for (const r of LIVE_RULES) {
      expect(r.defaultSeverity).toBe("warn");
      expect(r.source).toMatch(/SEP-\d+|changelog/);
    }
  });

  it("stateless-ready: passes on a modern connection, warns on a legacy fallback or empty supportedVersions", async () => {
    expect(await findings(fake({}), "stateless-ready")).toEqual([]);
    const legacy = await findings(fake({ getProtocolEra: () => "legacy" }), "stateless-ready");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ severity: "warn", probe: true });
    expect(legacy[0]!.message).toContain("SEP-2575");
    expect(await findings(fake({ discover: async () => ({}) }), "stateless-ready")).toHaveLength(1);
    expect(await findings(fake({ listTools: async () => { throw new Error("boom"); } }), "stateless-ready")).toHaveLength(1);
  });

  it("deterministic-list-order: flags a reordered or changing list, passes a stable one", async () => {
    expect(await findings(fake({}), "deterministic-list-order")).toEqual([]);
    let n = 0;
    const flip = fake({ listTools: async () => ({ tools: n++ % 2 === 0 ? [{ name: "a" }, { name: "b" }] : [{ name: "b" }, { name: "a" }] }) });
    const f = await findings(flip, "deterministic-list-order");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("different order");
    let m = 0;
    const grow = fake({ listTools: async () => ({ tools: m++ % 2 === 0 ? [{ name: "a" }] : [{ name: "a" }, { name: "c" }] }) });
    expect((await findings(grow, "deterministic-list-order"))[0]!.message).toContain("different tool sets");
  });

  it("deterministic-list-order: follows pagination and bypasses the client cache", async () => {
    const modes: Array<string | undefined> = [];
    const paged = fake({
      listTools: async (p, o) => {
        modes.push(o?.cacheMode);
        return p?.cursor ? { tools: [{ name: "z" }] } : { tools: [{ name: "a" }], nextCursor: "2" };
      },
    });
    expect(await findings(paged, "deterministic-list-order")).toEqual([]);
    expect(modes.length).toBeGreaterThanOrEqual(4);
    expect(modes.every((m) => m === "bypass")).toBe(true);
  });

  it("resource-not-found-code: -32602 passes, legacy -32002 / other codes / success warn", async () => {
    expect(await findings(fake({}), "resource-not-found-code")).toEqual([]);
    const legacy = await findings(fake({ readResource: async () => { throw Object.assign(new Error("x"), { code: -32002 }); } }), "resource-not-found-code");
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.message).toContain("-32002");
    expect(legacy[0]!.message).toContain("SEP-2164");
    expect(await findings(fake({ readResource: async () => { throw Object.assign(new Error("x"), { code: -32603 }); } }), "resource-not-found-code")).toHaveLength(1);
    expect(await findings(fake({ readResource: async () => ({ contents: [] }) }), "resource-not-found-code")).toHaveLength(1);
  });

  it("skips rules whose capability the server lacks, honours --off style overrides, and survives a throwing probe", async () => {
    expect(await runProbes(fake({ caps: {} }), { rules: { "stateless-ready": "off" } })).toEqual([]);
    const boom = fake({ listTools: async () => { throw new Error("down"); } });
    const out = await runProbes(boom, { rules: { "stateless-ready": "off" } });
    expect(out.map((f) => f.rule)).toEqual(["deterministic-list-order"]);
    expect(out[0]!.message).toContain("probe could not run");
    const asError = await runProbes(fake({ getProtocolEra: () => "legacy" }), { rules: { "stateless-ready": "error" } });
    expect(asError.find((f) => f.rule === "stateless-ready")!.severity).toBe("error");
  });

  it("runs against a real in-process server: a modern server passes the probes", async () => {
    const spec = { tools: [{ name: "echo", description: "e", handler: () => ({ content: [] }) }] };
    const modern = new MockMCPServer(spec, { era: "modern" });
    const c1 = new Client({ name: "t", version: "0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await c1.connect(modern.transport());
    try {
      const out = await runProbes(c1 as unknown as ProbeClient);
      expect(out.filter((f) => f.rule === "stateless-ready")).toEqual([]);
      expect(out.filter((f) => f.rule === "deterministic-list-order")).toEqual([]);
    } finally {
      await c1.close();
    }
  });
});

describe("mcp-lint --probe CLI", () => {
  it("refuses --probe with a pinned --contract file", async () => {
    await expect(run(["--probe", "--contract", "x.json"])).rejects.toThrow(/cannot run against a pinned --contract/);
  });
});

describe("server-card probe rule (#85)", () => {
  const URL_ = "https://srv.example/mcp";
  const card = (over: Record<string, unknown> = {}) => ({
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "com.example/srv",
    version: "1.0.0",
    description: "d",
    remotes: [{ type: "streamable-http", url: URL_, supportedProtocolVersions: ["2026-07-28"] }],
    ...over,
  });
  const cardFetch = (doc: unknown, status = 200) =>
    (async () => new Response(typeof doc === "string" ? doc : JSON.stringify(doc), { status, headers: { "content-type": "application/mcp-server-card+json" } })) as unknown as typeof fetch;
  const live = (over: Partial<ProbeClient> = {}) => fake({ getServerVersion: () => ({ name: "srv", version: "1.0.0" }), getNegotiatedProtocolVersion: () => "2026-07-28", ...over });
  const run = (c: ProbeClient, f: typeof fetch, url: string | undefined = URL_) => runProbes(c, { url, fetch: f }).then((r) => r.filter((x) => x.rule === "server-card"));

  it("is silent for a server without an HTTP URL (stdio)", async () => {
    expect(await run(live(), cardFetch(card()), undefined)).toEqual([]);
  });

  it("passes when the card agrees with the live connection", async () => {
    expect(await run(live(), cardFetch(card()))).toEqual([]);
  });

  it("warns when no card is published (404) and when the card is unusable", async () => {
    const missing = await run(live(), cardFetch("nope", 404));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ severity: "warn", probe: true, target: "https://srv.example/mcp/server-card" });
    expect(missing[0]!.message).toContain("no Server Card");
    const broken = await run(live(), cardFetch({ not: "a card" }));
    expect(broken[0]!.message).toContain("could not be used");
  });

  it("flags a card that disagrees with the live negotiated and supported versions", async () => {
    const stale = card({ remotes: [{ type: "streamable-http", url: URL_, supportedProtocolVersions: ["2025-11-25"] }] });
    const f = await run(live(), cardFetch(stale));
    expect(f.map((x) => x.message).join("\n")).toMatch(/negotiated 2026-07-28, which the card does not list/);
    expect(f.map((x) => x.message).join("\n")).toMatch(/live offers 2026-07-28/);
  });

  it("flags a card whose endpoint is not the one that was linted, and a different server version", async () => {
    const other = card({ version: "9.9.9", remotes: [{ type: "streamable-http", url: "https://elsewhere.example/mcp", supportedProtocolVersions: ["2026-07-28"] }] });
    const msgs = (await run(live(), cardFetch(other))).map((x) => x.message).join("\n");
    expect(msgs).toContain("does not match any remote");
    expect(msgs).toContain("card version 9.9.9 vs live 1.0.0");
  });

  it("can be turned off, and strips terminal escapes from card text", async () => {
    expect(await runProbes(live(), { url: URL_, fetch: cardFetch("nope", 404), rules: { "server-card": "off" } })).toEqual([]);
    const evil = card({ name: "com.example/\u001b[31mred" });
    // an invalid name fails schema validation; the failure message must not carry the raw escape
    const f = await run(live(), cardFetch(evil));
    expect(f.map((x) => x.message).join("")).not.toContain("\u001b");
  });
});

describe("reserved-error-range", () => {
  const coded = (code: number) => async () => {
    throw Object.assign(new Error("boom"), { code });
  };
  const codes = (over: Fake = {}) => fake({ request: coded(-32601), callTool: coded(-32602), readResource: coded(-32602), ...over });
  const run = (c: ProbeClient) => findings(c, "reserved-error-range");

  it("passes when every probe answers with a standard code", async () => {
    expect(await run(codes())).toEqual([]);
  });

  it("flags an unassigned code in -32020..-32099 and says what to use instead", async () => {
    const f = await run(codes({ callTool: coded(-32050) }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "warn", probe: true });
    expect(f[0]!.target).toContain("tools/call mcp-lint-probe-no-such-tool");
    expect(f[0]!.message).toContain("-32050");
    expect(f[0]!.message).toContain("reserved for the MCP specification");
  });

  it("flags an assigned code used for a condition it does not describe", async () => {
    const f = await run(codes({ request: coded(-32021) }));
    expect(f.map((x) => x.message).join("\n")).toContain("MissingRequiredClientCapability");
    expect(f[0]!.message).toContain("-32601");
  });

  it("reads the code out of an SDK transport error that embeds the JSON-RPC body (HTTP status errors)", async () => {
    const wrapped = Object.assign(new Error('Error POSTing to endpoint: {"jsonrpc":"2.0","id":0,"error":{"code":-32044,"message":"x"}}'), { code: "CLIENT_HTTP_NOT_IMPLEMENTED" });
    const f = await run(codes({ request: async () => { throw wrapped; } }));
    expect(f).toHaveLength(2); // the unknown-method and the nameless tools/call steps both go through request()
    expect(f[0]!.message).toContain("-32044");
  });

  it("covers a missing resource and a nameless tools/call", async () => {
    const f = await run(codes({ readResource: coded(-32030) }));
    expect(f).toHaveLength(1);
    expect(f[0]!.target).toContain("resources/read");
    const seen: string[] = [];
    await run(codes({ request: async (r) => { seen.push(`${r.method} ${JSON.stringify(r.params ?? null)}`); throw Object.assign(new Error("x"), { code: -32602 }); } }));
    expect(seen.some((s) => s.startsWith("tools/call {}"))).toBe(true);
  });

  it("does not flag legacy codes outside the range (-32000..-32019, -32002, -32603) or non-RPC errors", async () => {
    expect(await run(codes({ request: coded(-32002), callTool: coded(-32000), readResource: coded(-32603) }))).toEqual([]);
    expect(await run(codes({ request: async () => { throw new Error("socket closed"); } }))).toEqual([]);
  });

  it("is silent on a legacy-era connection and skips steps whose capability is missing", async () => {
    expect(await run(codes({ getProtocolEra: () => "legacy", callTool: coded(-32050) }))).toEqual([]);
    expect(await run(codes({ caps: { tools: {} }, readResource: coded(-32050) }))).toEqual([]);
    expect(await run(codes({ caps: {}, callTool: coded(-32050) }))).toEqual([]);
  });

  it("never calls a real tool: only a made-up name, and nothing when listTools has real ones", async () => {
    const names: string[] = [];
    await run(codes({ listTools: async () => ({ tools: [{ name: "delete-everything" }] }), callTool: async (p) => { names.push(p.name); throw Object.assign(new Error("x"), { code: -32602 }); } }));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^mcp-lint-probe-no-such-tool-/);
  });

  it("runs against a real in-process server (unknown method, unknown tool, missing resource)", async () => {
    const spec = { tools: [{ name: "echo", description: "e", handler: () => ({ content: [] }) }], resources: [{ uri: "mem://a", name: "a", read: () => "x" }] };
    const server = new MockMCPServer(spec as never, { era: "modern" });
    const c = new Client({ name: "t", version: "0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await c.connect(server.transport());
    try {
      expect(await run(c as unknown as ProbeClient)).toEqual([]);
    } finally {
      await c.close();
    }
  });
});

describe("sse-only-transport", () => {
  const URL_ = "https://legacy.example/sse";
  const sse = (body: string) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const route = (handlers: { post: () => Response; get: () => Response }) =>
    (async (_u: unknown, init?: RequestInit) => (init?.method === "POST" ? handlers.post() : handlers.get())) as unknown as typeof fetch;
  const check = (f: typeof fetch) => runDisconnectedProbes({ url: URL_, fetch: f, timeoutMs: 100 });

  it("flags an HTTP+SSE-only server (POST not JSON-RPC, GET opens an endpoint event)", async () => {
    const out = await check(route({ post: () => new Response("Not Found", { status: 404 }), get: () => sse("event: endpoint\ndata: /messages?sessionId=1\n\n") }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "sse-only-transport", severity: "warn", probe: true, target: URL_ });
    expect(out[0]!.message).toContain("SEP-2596");
  });

  it("passes a Streamable HTTP server whether it answers with JSON-RPC success, a JSON-RPC error, or a stream", async () => {
    const get = () => sse("event: endpoint\ndata: x\n\n"); // must not even matter
    expect(await check(route({ post: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } }), get }))).toEqual([]);
    expect(await check(route({ post: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } }), { status: 400 }), get }))).toEqual([]);
    expect(await check(route({ post: () => sse("data: {}\n\n"), get }))).toEqual([]);
  });

  it("stays silent when the GET is not an endpoint stream, when the host is unreachable, and without a URL", async () => {
    expect(await check(route({ post: () => new Response("", { status: 405 }), get: () => new Response("no", { status: 405 }) }))).toEqual([]);
    expect(await check(route({ post: () => new Response("", { status: 405 }), get: () => sse("event: message\ndata: {}\n\n") }))).toEqual([]);
    expect(await check((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toEqual([]);
    expect(await runDisconnectedProbes({})).toEqual([]);
  });

  it("honours --off, sends configured headers, and is a no-op on a connected client", async () => {
    const f = route({ post: () => new Response("", { status: 404 }), get: () => sse("event: endpoint\ndata: /m\n\n") });
    expect(await runDisconnectedProbes({ url: URL_, fetch: f, rules: { "sse-only-transport": "off" } })).toEqual([]);
    expect((await runDisconnectedProbes({ url: URL_, fetch: f, rules: { "sse-only-transport": "error" } }))[0]!.severity).toBe("error");
    const seen: Array<Record<string, string>> = [];
    await runDisconnectedProbes({ url: URL_, headers: { Authorization: "Bearer t" }, fetch: (async (_u: unknown, init?: RequestInit) => { seen.push(init!.headers as Record<string, string>); return new Response("", { status: 404 }); }) as unknown as typeof fetch });
    expect(seen.every((h) => h.Authorization === "Bearer t")).toBe(true);
    expect((await runProbes(fake({}), { url: URL_, fetch: f })).filter((x) => x.rule === "sse-only-transport")).toEqual([]);
  });
});
