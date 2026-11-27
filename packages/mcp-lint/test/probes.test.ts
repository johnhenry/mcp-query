import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { run } from "../src/cli.js";
import { lintContract } from "../src/lint.js";
import { LIVE_RULES, runProbes, type ProbeClient } from "../src/probes.js";

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
    expect(ids).toEqual(new Set(["stateless-ready", "deterministic-list-order", "resource-not-found-code", "server-card"]));
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
