import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, helpText, parseClient } from "../src/cli.js";
import { connectFor, eraFor, usesRounds } from "../src/invoke.js";
import { serverKey } from "../src/daemon/protocol.js";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { Client } from "@modelcontextprotocol/client";

const FIXTURE = fileURLToPath(new URL("../../mcp-contract/test/helpers/legacyStdioServer.mjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cli-era-"));
  dirs.push(d);
  return d;
};
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("--era default", () => {
  it("is auto for every connecting verb; --era legacy opts out; a registry pin applies unless a flag says otherwise", () => {
    expect(eraFor({})).toBe("auto");
    expect(eraFor({ era: "legacy" })).toBe("legacy");
    expect(eraFor({ era: "auto" }, "legacy")).toBe("auto"); // the flag beats the pin
    expect(eraFor({}, "legacy")).toBe("legacy");
    expect(eraFor({ answers: ["a=b"] }, "legacy")).toBe("auto"); // --answer needs a 2026-07-28 connection
    expect(() => eraFor({ era: "legacy", answers: ["a=b"] })).toThrow(/drop --era legacy/);
    expect(() => eraFor({ era: "modern" })).toThrow(/--era must be "legacy".*"auto"/);
  });

  it("is not set by the flag parser (the default is applied at connect time, per server)", () => {
    for (const verb of ["tools", "call", "read", "prompt", "skills", "skill", "tasks", "ping", "session"]) {
      expect(parseClient(["srv"], verb).flags.era).toBeUndefined();
    }
    expect(parseClient(["srv", "--era", "legacy"], "tools").flags.era).toBe("legacy");
  });

  it("help and daemon key describe/track it", () => {
    expect(helpText()).toMatch(/--era auto\|legacy\s+auto \(default\)/);
    expect(serverKey({ command: "x", args: "y", era: "legacy" })).toBe("stdio:x y#legacy");
    expect(serverKey({ command: "x", args: "y", era: "auto" })).toBe("stdio:x y"); // unchanged for the default
    expect(serverKey({ url: "https://h/mcp", era: "legacy" })).not.toBe(serverKey({ url: "https://h/mcp" }));
  });

  it("usesRounds: modern connections and --answer run the input_required loop, legacy ones do not", async () => {
    const modern = new MockMCPServer({ tools: [] }, { era: "modern" });
    const cm = new Client({ name: "t", version: "0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await cm.connect(modern.transport());
    const legacy = new MockMCPServer({ tools: [] }, { era: "legacy" });
    const cl = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await cl.connect(legacy.transport());
    try {
      expect(usesRounds(cm, {})).toBe(true);
      expect(usesRounds(cl, {})).toBe(false);
      expect(usesRounds(cl, { answers: ["a=b"] })).toBe(true);
    } finally {
      await cm.close();
      await cl.close();
    }
  });
});

describe("registry era pin: `mcp-query add --era`", () => {
  it("writes the pin, lists it, and makes the connection skip the probe (one spawn instead of two)", async () => {
    const dir = tmp();
    const cfg = join(dir, "servers.json");
    const marksPlain = join(dir, "marks-auto");
    const marksPinned = join(dir, "marks-pinned");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s?: unknown) => void out.push(String(s)));

    await run(["add", "plain", "--command", process.execPath, "--args", FIXTURE, "--config", cfg]);
    await run(["add", "pinned", "--command", process.execPath, "--args", FIXTURE, "--era", "legacy", "--config", cfg]);
    const file = JSON.parse(readFileSync(cfg, "utf8")).mcpServers;
    expect(file.pinned.era).toBe("legacy");
    expect(file.plain.era).toBeUndefined();
    await expect(run(["add", "bad", "--command", "x", "--era", "modern", "--config", cfg])).rejects.toThrow(/--era must be/);

    out.length = 0;
    await run(["servers", "--config", cfg]);
    expect(out.join("\n")).toMatch(/pinned.*legacy/s);

    // Point both entries' fixtures at their own mark files via the entry env.
    const servers = JSON.parse(readFileSync(cfg, "utf8"));
    servers.mcpServers.plain.env = { FIXTURE_MARK: marksPlain };
    servers.mcpServers.pinned.env = { FIXTURE_MARK: marksPinned };
    writeFileSync(cfg, JSON.stringify(servers));

    const starts = (f: string): number => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("start")).length : 0);
    const a = await connectFor("plain", { config: cfg });
    await a.close();
    const b = await connectFor("pinned", { config: cfg });
    await b.close();
    await until(() => existsSync(marksPinned) && readFileSync(marksPinned, "utf8").includes("stdin-closed"));
    expect(starts(marksPlain)).toBe(2); // default auto: probe sibling + the real connection
    expect(starts(marksPinned)).toBe(1); // pinned legacy: no probe
  });

  it("--era on the command line beats the pin", async () => {
    const dir = tmp();
    const cfg = join(dir, "servers.json");
    const marks = join(dir, "marks");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_MARK: marks }, era: "legacy" } } }));
    const c = await connectFor("s", { config: cfg, era: "auto" });
    await c.close();
    await until(() => readFileSync(marks, "utf8").includes("stdin-closed"));
    expect(readFileSync(marks, "utf8").split("\n").filter((l) => l.startsWith("start"))).toHaveLength(2);
  });
});
