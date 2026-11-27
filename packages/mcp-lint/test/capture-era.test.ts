// mcp-lint (non-probe) captures with --era auto by default; a legacy-only server must lint exactly as before.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, vi } from "vitest";
import { run } from "../src/cli.js";
import { lintContract } from "../src/lint.js";
import { formatLint } from "../src/report.js";
import type { Contract } from "../../mcp-contract/src/index.js";
import { runCli } from "../../mcp-contract/test/helpers/cliHarness.js";

vi.setConfig({ testTimeout: 60_000 }); // each test spawns real server processes; slow on a loaded CI runner

const DUAL = fileURLToPath(new URL("../../mcp-contract/test/helpers/dualStdioServer.mjs", import.meta.url));
const LEGACY_ONLY = fileURLToPath(new URL("../../mcp-contract/test/helpers/legacyStdioServer.mjs", import.meta.url));
const target = (script: string): string[] => ["--command", process.execPath, "--args", script];

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
const savedEnv = process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
  else process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = savedEnv;
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lint-era-"));
  dirs.push(d);
  return d;
};

const base: Contract = { version: 2, tools: [{ name: "echo", title: "Echo", description: "d", inputSchema: { type: "object" } }], resources: [], templates: [], prompts: [] };

describe("cache-hints on a legacy capture: not evaluated, not warned", () => {
  it("a legacy-era capture (or one with no recorded era) skips the rule and says why; it never warns", () => {
    for (const protocol of [{ era: "legacy" as const, negotiated: "2025-06-18" }, undefined]) {
      const r = lintContract({ ...base, ...(protocol ? { protocol } : {}), cacheHints: { tools: {} } });
      expect(r.findings.filter((f) => f.rule === "cache-hints")).toEqual([]);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped![0]!.rule).toBe("cache-hints");
      expect(r.skipped![0]!.reason).toMatch(/not evaluated.*carries no cache hints/);
    }
    const out = formatLint(lintContract({ ...base, protocol: { era: "legacy" }, cacheHints: { tools: {} } }));
    expect(out).toContain("✓ no lint findings");
    expect(out).toContain("cache-hints: not evaluated");
  });

  it("a modern capture is evaluated (and warns when a hint is missing); --off silences the note too", () => {
    const modern: Contract = { ...base, protocol: { era: "modern" }, cacheHints: { tools: { ttlMs: 5 } } };
    const r = lintContract(modern);
    expect(r.skipped).toBeUndefined();
    expect(r.findings.filter((f) => f.rule === "cache-hints")).toHaveLength(1);
    expect(lintContract({ ...base, protocol: { era: "legacy" } }, { rules: { "cache-hints": "off" } }).skipped).toBeUndefined();
  });
});

describe("mcp-lint --era", () => {
  it("a legacy-only server lints identically with the default and with --era legacy", async () => {
    const dflt = await runCli(run, target(LEGACY_ONLY));
    const legacy = await runCli(run, [...target(LEGACY_ONLY), "--era", "legacy"]);
    expect(dflt.code).toBe(legacy.code);
    expect(dflt.err).toBe(legacy.err);
    expect(dflt.err).not.toMatch(/cache-hints\)/); // no cache-hints warning, only the "not evaluated" note
  });

  it("a dual-era server is captured over the modern handshake by default (cache hints evaluated), legacy on request", async () => {
    const dflt = await runCli(run, target(DUAL));
    expect(dflt.err).not.toContain("not evaluated");
    const legacy = await runCli(run, [...target(DUAL), "--era", "legacy"]);
    expect(legacy.err).toContain("cache-hints: not evaluated");
  });

  it("refuses a bad value, and --probe together with --era legacy", async () => {
    await expect(run([...target(DUAL), "--era", "modern"])).rejects.toThrow(/--era must be/);
    await expect(run([...target(DUAL), "--probe", "--era", "legacy"])).rejects.toThrow(/--probe needs the default --era auto/);
  });

  it("a registry pin makes the capture legacy; the flag beats it", async () => {
    const cfg = join(tmp(), "servers.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { dual: { command: process.execPath, args: [DUAL], era: "legacy" } } }));
    expect((await runCli(run, ["--server", "dual", "--config", cfg])).err).toContain("cache-hints: not evaluated");
    expect((await runCli(run, ["--server", "dual", "--config", cfg, "--era", "auto"])).err).not.toContain("not evaluated");
  });

  it("a pinned legacy contract file is linted without cache-hint warnings", async () => {
    const path = join(tmp(), "c.json");
    writeFileSync(path, JSON.stringify({ ...base, protocol: { era: "legacy", negotiated: "2025-06-18" }, cacheHints: { tools: {} } }));
    const r = await runCli(run, ["--contract", path]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("cache-hints: not evaluated");
  });

  it("a server that never answers the probe cannot hang the lint (bounded, legacy, no process left running)", async () => {
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "400";
    const mark = join(tmp(), "marks");
    const cfg = join(tmp(), "servers.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { quiet: { command: process.execPath, args: [LEGACY_ONLY], env: { FIXTURE_MARK: mark, FIXTURE_MODE: "silent" } } } }));
    const started = Date.now();
    const r = await runCli(run, ["--server", "quiet", "--config", cfg]);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.err).toContain("cache-hints: not evaluated");
    const pids = (existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n") : []).filter((l) => l.startsWith("start")).map((l) => Number(l.split(" ")[1]));
    expect(pids).toHaveLength(2);
    await until(() => pids.every((p) => !alive(p)));
  });
});
