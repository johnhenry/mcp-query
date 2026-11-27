// The capture tools (mcp-contract CLI, captureFrom/connectClient) default to `--era auto`. A contract pinned from a
// legacy (initialize) capture must still verify against a modern (server/discover) capture of the same server.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer, type MockSpec } from "../../mcp-query/src/testing/mockServer.js";
import { run } from "../src/cli.js";
import { captureContract, captureEra, captureFrom, connectClient, diffContract, entryToConnectOptions, formatDiff, type Contract } from "../src/index.js";
import { runCli } from "./helpers/cliHarness.js";
import { serveMock } from "./helpers/httpMock.js";

const DUAL = fileURLToPath(new URL("./helpers/dualStdioServer.mjs", import.meta.url));
const LEGACY_ONLY = fileURLToPath(new URL("./helpers/legacyStdioServer.mjs", import.meta.url));

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const savedEnv = process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
  else process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = savedEnv;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "capture-era-"));
  dirs.push(d);
  return d;
}

/** Stdio options for a fixture, with a mark file recording every process start. */
function stdio(script: string, extraEnv: Record<string, string> = {}) {
  const mark = join(tmp(), "marks");
  return {
    opts: { command: process.execPath, args: script, env: { FIXTURE_MARK: mark, ...extraEnv } },
    marks: () => (existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n").filter(Boolean).map((l) => ({ what: l.split(" ")[0]!, pid: Number(l.split(" ")[1]) })) : []),
  };
}
/** `--command/--args` for the CLI. */
const cliTarget = (script: string): string[] => ["--command", process.execPath, "--args", script];

async function snapshotFile(argv: string[]): Promise<{ path: string; contract: Contract }> {
  const path = join(tmp(), "c.json");
  const r = await runCli(run, ["snapshot", ...argv, "--out", path]);
  expect(r.code, r.err).toBe(0);
  return { path, contract: JSON.parse(readFileSync(path, "utf8")) as Contract };
}

describe("library: connectClient / captureFrom default to era auto", () => {
  it("a dual-era server is captured over server/discover by default and over initialize with era: legacy", async () => {
    const { opts } = stdio(DUAL);
    const modern = await captureFrom(opts);
    expect(modern.protocol).toMatchObject({ era: "modern", negotiated: "2026-07-28" });
    expect(modern.protocol?.supported).toContain("2026-07-28");
    expect(modern.cacheHints?.discover).toEqual({ ttlMs: 0, cacheScope: "private" });
    expect(modern.cacheHints?.tools).toEqual({ ttlMs: 0, cacheScope: "private" });

    const legacy = await captureFrom({ ...opts, era: "legacy" });
    expect(legacy.protocol?.era).toBe("legacy");
    expect(legacy.protocol?.supported).toBeUndefined();
    expect(legacy.cacheHints?.discover).toBeUndefined();
    expect(legacy.cacheHints?.tools).toEqual({});
    // Same server, same surface: only the era-dependent fields differ.
    expect(legacy.tools).toEqual(modern.tools);
    expect(legacy.extensions).toEqual(modern.extensions);
  });

  it("connectClient defaults to auto and honours a registry pin", async () => {
    const { opts } = stdio(DUAL);
    const a = await connectClient(opts);
    expect(a.client.getProtocolEra?.()).toBe("modern");
    await a.close();
    const pinned = entryToConnectOptions({ command: process.execPath, args: [DUAL], era: "legacy" });
    const b = await connectClient(pinned);
    expect(b.client.getProtocolEra?.()).toBe("legacy");
    await b.close();
  });

  it("a legacy-only server falls back to initialize and is captured as legacy", async () => {
    const c = await captureFrom(stdio(LEGACY_ONLY).opts);
    expect(c.protocol?.era).toBe("legacy");
    expect(c.tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("does not leave a stdio server running twice: the probe sibling is reaped, one server stays up, none after close", async () => {
    const { opts, marks } = stdio(DUAL);
    const { client, close } = await connectClient(opts);
    await captureContract(client);
    const starts = marks().filter((m) => m.what === "start");
    expect(starts).toHaveLength(2); // the cost of auto: a short-lived sibling for the probe
    await until(() => starts.filter((s) => alive(s.pid)).length === 1);
    await close();
    await until(() => starts.every((s) => !alive(s.pid)));
  });

  it("a server that never answers the probe cannot hang the capture (bounded timeout, then legacy; every process reaped)", async () => {
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "400";
    const { opts, marks } = stdio(LEGACY_ONLY, { FIXTURE_MODE: "silent" });
    const started = Date.now();
    const c = await captureFrom(opts);
    expect(Date.now() - started).toBeLessThan(8000); // far below the SDK's 60 s default request timeout
    expect(c.protocol?.era).toBe("legacy");
    const starts = marks().filter((m) => m.what === "start");
    await until(() => starts.every((s) => !alive(s.pid)));
  });

  it("over HTTP: a dual-era server is captured modern by default and legacy on request", async () => {
    const h = await serveMock(new MockMCPServer({ tools: [{ name: "echo", description: "e", handler: () => ({ content: [] }) }] }));
    closers.push(h.close);
    expect((await captureFrom({ url: h.url })).protocol?.era).toBe("modern");
    expect((await captureFrom({ url: h.url, era: "legacy" })).protocol?.era).toBe("legacy");
  });
});

describe("mcp-contract CLI --era", () => {
  it("snapshot defaults to auto and records the era; --era legacy records legacy; a bad value is refused", async () => {
    const modern = await snapshotFile(cliTarget(DUAL));
    expect(modern.contract.protocol?.era).toBe("modern");
    const legacy = await snapshotFile([...cliTarget(DUAL), "--era", "legacy"]);
    expect(legacy.contract.protocol?.era).toBe("legacy");
    await expect(run(["snapshot", ...cliTarget(DUAL), "--era", "modern"])).rejects.toThrow(/--era must be "legacy".*"auto"/);
  });

  it("a registry pin applies when --era is not given, and the flag beats the pin", async () => {
    const dir = tmp();
    const cfg = join(dir, "servers.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { dual: { command: process.execPath, args: [DUAL], era: "legacy" } } }));
    expect((await snapshotFile(["--server", "dual", "--config", cfg])).contract.protocol?.era).toBe("legacy");
    expect((await snapshotFile(["--server", "dual", "--config", cfg, "--era", "auto"])).contract.protocol?.era).toBe("modern");
  });

  it("a server that never answers the probe does not hang snapshot (bounded, legacy, every process reaped)", async () => {
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "400";
    const { opts, marks } = stdio(LEGACY_ONLY, { FIXTURE_MODE: "silent" });
    const cfg = join(tmp(), "servers.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { quiet: { command: opts.command, args: [opts.args], env: opts.env } } }));
    const started = Date.now();
    const { contract } = await snapshotFile(["--server", "quiet", "--config", cfg]);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(contract.protocol?.era).toBe("legacy");
    const starts = marks().filter((m) => m.what === "start");
    expect(starts).toHaveLength(2);
    await until(() => starts.every((s) => !alive(s.pid)));
  });

  it("--help documents the flag", async () => {
    const r = await runCli(run, ["--help"]);
    expect(r.out).toMatch(/--era auto\|legacy/);
    expect(r.out).toContain("--era auto (default) probes server/discover first");
  });
});

describe("verify / diff across capture eras: no CI failure for an unchanged server", () => {
  it("a legacy pin (v2 file) verifies against the default capture of the same server: exit 0, no breaking change, era difference stated", async () => {
    const pin = await snapshotFile([...cliTarget(DUAL), "--era", "legacy"]);
    const r = await runCli(run, ["verify", ...cliTarget(DUAL), "--contract", pin.path]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toMatch(/BREAKING/);
    expect(r.err).toMatch(/capture era differs: pinned with initialize \(legacy\), this capture used server\/discover \(2026-07-28\)/);
    expect(r.err).toMatch(/not captured before|were not captured before/);
  });

  it("the same holds for a v1 file and for a v2 file that predates protocol.era", async () => {
    const legacy = (await snapshotFile([...cliTarget(DUAL), "--era", "legacy"])).contract;
    const v1 = join(tmp(), "v1.json");
    writeFileSync(v1, JSON.stringify({ version: 1, server: legacy.server, tools: legacy.tools, resources: [], templates: [], prompts: [] }));
    const v2old = join(tmp(), "v2old.json");
    const { protocol: _p, ...rest } = legacy;
    writeFileSync(v2old, JSON.stringify(rest));
    for (const path of [v1, v2old]) {
      const r = await runCli(run, ["verify", ...cliTarget(DUAL), "--contract", path]);
      expect(r.code, r.err).toBe(0);
      expect(r.err).not.toMatch(/BREAKING/);
    }
  });

  it("diff <old file> <live> reports the same way", async () => {
    const pin = await snapshotFile([...cliTarget(DUAL), "--era", "legacy"]);
    const r = await runCli(run, ["diff", pin.path, ...cliTarget(DUAL)]);
    expect(r.code).toBe(0);
    expect(r.err).not.toMatch(/BREAKING/);
    expect(r.err).toContain("capture era differs");
  });

  it("a modern pin verified with --era legacy is not a breaking change either: the capture era differs, nothing is called removed", async () => {
    const pin = await snapshotFile(cliTarget(DUAL));
    const r = await runCli(run, ["verify", ...cliTarget(DUAL), "--era", "legacy", "--contract", pin.path]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toMatch(/BREAKING/);
    expect(r.err).toMatch(/pinned with server\/discover \(2026-07-28\), this capture used initialize \(legacy\)/);
    expect(r.err).toMatch(/not reported as removed/);
  });

  it("same era in both directions says nothing about eras", async () => {
    const pin = await snapshotFile(cliTarget(DUAL));
    const r = await runCli(run, ["verify", ...cliTarget(DUAL), "--contract", pin.path]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("no changes");
    expect(r.err).not.toContain("capture era");
  });

  it("over HTTP too (pin --era legacy, verify with the default)", async () => {
    const h = await serveMock(new MockMCPServer({ tools: [{ name: "echo", description: "e", handler: () => ({ content: [] }) }] }));
    closers.push(h.close);
    const pin = await snapshotFile(["--url", h.url, "--era", "legacy"]);
    expect(pin.contract.protocol?.era).toBe("legacy");
    const r = await runCli(run, ["verify", "--url", h.url, "--contract", pin.path]);
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toMatch(/BREAKING/);
  });

  it("real drift still fails verify across eras (a removed tool is breaking whichever handshake captured it)", async () => {
    const pin = await snapshotFile([...cliTarget(DUAL), "--era", "legacy"]);
    const edited = JSON.parse(readFileSync(pin.path, "utf8")) as Contract;
    edited.tools.push({ name: "gone", description: "removed since the pin", inputSchema: { type: "object" } });
    writeFileSync(pin.path, JSON.stringify(edited));
    const r = await runCli(run, ["verify", ...cliTarget(DUAL), "--contract", pin.path]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/BREAKING.*tool gone/);
  });
});

// ── in-process: classification on a modern capture ───────────────────────────────────────────────

async function capture(spec: MockSpec, era: "legacy" | "modern"): Promise<Contract> {
  const mock = new MockMCPServer(spec, { era });
  const client = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: era === "modern" ? "auto" : "legacy" } });
  await client.connect(mock.transport());
  const c = await captureContract(client);
  await client.close();
  await mock.close();
  return c;
}
const echo = (schema: Record<string, unknown> = { type: "object", properties: { message: { type: "string" } }, required: ["message"] }) => ({
  name: "echo",
  description: "e",
  inputSchema: schema,
  handler: () => ({ content: [] }),
});
const spec = (over: Partial<MockSpec> = {}): MockSpec => ({ tools: [echo() as never], capabilities: { tools: {}, extensions: { "io.example/widgets": { revision: "2026-09-01" } } }, ...over });
const breaking = (d: ReturnType<typeof diffContract>) => d.changes.filter((c) => c.level === "breaking");

describe("real drift is caught on the modern path", () => {
  it("an unchanged modern server: no changes, no era note", async () => {
    const d = diffContract(await capture(spec(), "modern"), await capture(spec(), "modern"));
    expect(d.changes).toEqual([]);
    expect(d.notes).toBeUndefined();
  });

  it("a dropped protocol version is breaking, an added one compatible", async () => {
    const live = await capture(spec(), "modern");
    const pin = structuredClone(live);
    pin.protocol!.supported = ["2025-11-25", ...live.protocol!.supported!];
    const dropped = diffContract(pin, live);
    expect(breaking(dropped).map((c) => [c.category, c.target, c.detail])).toEqual([["protocol", "2025-11-25", "protocol version no longer supported"]]);
    const added = diffContract(live, pin);
    expect(added.breaking).toBe(0);
    expect(added.changes.map((c) => [c.category, c.target, c.level])).toEqual([["protocol", "2025-11-25", "compatible"]]);
  });

  it("a removed extension, a moved extension revision and a removed capability are breaking", async () => {
    const pin = await capture(spec({ capabilities: { tools: {}, prompts: {}, extensions: { "io.example/widgets": { revision: "2026-09-01" } } }, prompts: [{ name: "p", description: "d" } as never] }), "modern");
    const noExt = await capture(spec({ capabilities: { tools: {}, prompts: {} }, prompts: [{ name: "p", description: "d" } as never] }), "modern");
    expect(breaking(diffContract(pin, noExt)).map((c) => [c.category, c.target])).toEqual([["extension", "io.example/widgets"]]);
    const moved = await capture(spec({ capabilities: { tools: {}, prompts: {}, extensions: { "io.example/widgets": { revision: "2027-01-01" } } }, prompts: [{ name: "p", description: "d" } as never] }), "modern");
    expect(breaking(diffContract(pin, moved)).map((c) => [c.category, c.target, c.detail])).toEqual([["extension", "io.example/widgets", "revision 2026-09-01 → 2027-01-01"]]);
    const noPrompts = await capture(spec(), "modern");
    expect(breaking(diffContract(pin, noPrompts)).map((c) => [c.category, c.target])).toContainEqual(["capability", "prompts"]);
  });

  it("a narrowed input schema (a new required argument) is breaking", async () => {
    const pin = await capture(spec(), "modern");
    const live = await capture(spec({ tools: [echo({ type: "object", properties: { message: { type: "string" }, mode: { type: "string" } }, required: ["message", "mode"] }) as never] }), "modern");
    expect(breaking(diffContract(pin, live)).map((c) => [c.category, c.target])).toEqual([["tool", "echo"]]);
  });

  it("a removed tool is breaking", async () => {
    const pin = await capture(spec(), "modern");
    const live = await capture(spec({ tools: [] }), "modern");
    expect(breaking(diffContract(pin, live)).map((c) => [c.category, c.target, c.detail])).toEqual([["tool", "echo", "removed"]]);
  });
});

describe("capture era difference in the differ", () => {
  it("records the era: protocol.era on both captures, inferred when a file lacks it", async () => {
    const m = await capture(spec(), "modern");
    const l = await capture(spec(), "legacy");
    expect([captureEra(m), captureEra(l)]).toEqual(["modern", "legacy"]);
    expect(captureEra({ ...m, protocol: { supported: ["2026-07-28"] } })).toBe("modern");
    expect(captureEra({ ...l, protocol: { negotiated: "2025-06-18" } })).toBe("legacy");
    expect(captureEra({ ...l, protocol: undefined })).toBeUndefined();
  });

  it("legacy pin vs modern capture of the same server: no breaking change, cache hints and supported versions are 'not captured'", async () => {
    const d = diffContract(await capture(spec(), "legacy"), await capture(spec(), "modern"));
    expect(d.breaking).toBe(0);
    expect(d.changes).toEqual([]);
    expect(d.notes).toHaveLength(1);
    expect(formatDiff(d)).toContain("capture era differs");
  });

  it("modern pin vs legacy capture: no breaking change even though the legacy capture lacks supported versions, hints and modern-only parts", async () => {
    const s = spec({ capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/events": {} } } });
    const pin = await capture(s, "modern");
    pin.skills = [{ uri: "skill://a", name: "a", files: [] }];
    pin.events = [{ name: "e", delivery: ["poll"] }];
    const live = await capture(spec({ capabilities: { tools: {} } }), "legacy");
    const d = diffContract(pin, live);
    expect(d.breaking).toBe(0);
    expect(d.notes?.[0]).toMatch(/pinned with server\/discover.*this capture used initialize/);
    // what the legacy capture lacks is downgraded, with the reason attached, rather than dropped silently
    expect(d.changes.some((c) => c.category === "extension" && c.level === "compatible" && /not comparable across capture eras/.test(c.detail))).toBe(true);
    expect(d.changes.some((c) => c.category === "skill" || c.category === "event")).toBe(false);
  });

  it("a tool removed or narrowed is breaking even across eras", async () => {
    const pin = await capture(spec(), "legacy");
    const live = await capture(spec({ tools: [echo({ type: "object", properties: { message: { type: "string" }, x: { type: "string" } }, required: ["message", "x"] }) as never] }), "modern");
    expect(breaking(diffContract(pin, live)).map((c) => c.target)).toEqual(["echo"]);
  });

  it("a v1 pin (no era, no v2 fields) against a modern capture reports no breaking change", async () => {
    const live = await capture(spec(), "modern");
    const v1 = { version: 1 as const, tools: live.tools, resources: [], templates: [], prompts: [] };
    const d = diffContract(v1, live);
    expect(d.breaking).toBe(0);
    expect(d.notes?.[0]).toMatch(/no era recorded/);
  });
});
