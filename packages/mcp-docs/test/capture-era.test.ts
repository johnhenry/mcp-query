// mcp-docs captures with --era auto by default; a legacy-only server's document must not change.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { run } from "../src/cli.js";
import { renderMarkdown } from "../src/render.js";

const DUAL = fileURLToPath(new URL("../../mcp-contract/test/helpers/dualStdioServer.mjs", import.meta.url));
const LEGACY_ONLY = fileURLToPath(new URL("../../mcp-contract/test/helpers/legacyStdioServer.mjs", import.meta.url));
const target = (script: string): string[] => ["--command", process.execPath, "--args", script];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function docs(argv: string[]): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "docs-era-"));
  dirs.push(d);
  const out = join(d, "API.md");
  const orig = console.error;
  console.error = () => {};
  try {
    await run([...argv, "--out", out]);
  } finally {
    console.error = orig;
  }
  return readFileSync(out, "utf8");
}

describe("mcp-docs --era", () => {
  it("a legacy-only server's document is identical with the default and with --era legacy, and states the era", async () => {
    const dflt = await docs(target(LEGACY_ONLY));
    const legacy = await docs([...target(LEGACY_ONLY), "--era", "legacy"]);
    expect(dflt).toBe(legacy);
    expect(dflt).toContain("**Protocol:** legacy era · negotiated `2025-");
  });

  it("a dual-era server is documented from the modern handshake by default and from the legacy one on request", async () => {
    const modern = await docs(target(DUAL));
    expect(modern).toMatch(/\*\*Protocol:\*\* modern era · negotiated `2026-07-28` · supports `2026-07-28`/);
    const legacy = await docs([...target(DUAL), "--era", "legacy"]);
    expect(legacy).toMatch(/\*\*Protocol:\*\* legacy era · negotiated/);
    // the reference sections are the same either way
    expect(modern.replace(/\*\*Protocol:\*\*.*\n/, "")).toBe(legacy.replace(/\*\*Protocol:\*\*.*\n/, ""));
  });

  it("states the era even when the capture recorded no versions; a registry pin applies and the flag beats it", async () => {
    expect(renderMarkdown({ version: 2, protocol: { era: "legacy" }, tools: [], resources: [], templates: [], prompts: [] })).toContain("**Protocol:** legacy era");
    const cfg = join(mkdtempSync(join(tmpdir(), "docs-era-cfg-")), "servers.json");
    dirs.push(join(cfg, ".."));
    writeFileSync(cfg, JSON.stringify({ mcpServers: { dual: { command: process.execPath, args: [DUAL], era: "legacy" } } }));
    expect(await docs(["--server", "dual", "--config", cfg])).toContain("legacy era");
    expect(await docs(["--server", "dual", "--config", cfg, "--era", "auto"])).toContain("modern era");
  });

  it("a server that never answers the probe does not hang the docs run (bounded, then legacy)", async () => {
    const saved = process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "400";
    try {
      const d = mkdtempSync(join(tmpdir(), "docs-era-"));
      dirs.push(d);
      const cfg = join(d, "servers.json");
      writeFileSync(cfg, JSON.stringify({ mcpServers: { quiet: { command: process.execPath, args: [LEGACY_ONLY], env: { FIXTURE_MODE: "silent" } } } }));
      const started = Date.now();
      expect(await docs(["--server", "quiet", "--config", cfg])).toContain("legacy era");
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      if (saved === undefined) delete process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
      else process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = saved;
    }
  });

  it("refuses a bad --era", async () => {
    await expect(run([...target(DUAL), "--era", "modern"])).rejects.toThrow(/--era must be/);
  });
});
