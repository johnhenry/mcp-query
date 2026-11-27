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
    expect(ids).toEqual(new Set(["stateless-ready", "deterministic-list-order", "resource-not-found-code"]));
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
