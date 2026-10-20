import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGateClient, redactValue, compilePolicy, resolveHttpUpstream } from "../src/index.browser.js";

const src = (f: string) => fileURLToPath(new URL(`../src/${f}`, import.meta.url));

// Bundle an entry for a browser platform. esbuild fails on unresolved `node:` builtins and
// Node-only packages (platform "browser" does not provide them), and the metafile lets us
// assert none of them were pulled in even as stubs.
async function bundleForBrowser(entry: string) {
  const r = await build({
    entryPoints: [src(entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["browser"],
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(r.metafile.inputs);
  return { code: r.outputFiles[0]!.text, inputs };
}

describe("browser-safe entries (#65)", { timeout: 60_000 }, () => {
  for (const entry of ["index.browser.ts", "policy.ts", "redact-entry.ts"]) {
    it(`${entry} bundles for a browser with no Node-only modules`, async () => {
      const { inputs } = await bundleForBrowser(entry);
      const bad = inputs.filter((i) => /node:|cross-spawn|upstream\.ts|\/stdio/.test(i));
      expect(bad).toEqual([]);
    });
  }

  it("the bundled browser entry compiles a policy and redacts a payload with no Node globals", async () => {
    const { code } = await bundleForBrowser("index.browser.ts");
    const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
    const m = (await import(/* @vite-ignore */ url)) as typeof import("../src/index.browser.js");
    const verdict = m.compilePolicy({ deny: ["fs.write_*"], approve: ["fs.read_secret"], denyDestructive: true });
    expect(verdict({ kind: "call", server: "fs", target: "write_file" } as never)).toBe("deny");
    expect(verdict({ kind: "call", server: "fs", target: "read_secret" } as never)).toBe("approve");
    expect(verdict({ kind: "call", server: "fs", target: "list" } as never)).toBe("allow");
    expect(m.redactValue([{ pattern: /sk-[a-z0-9]+/g }], { a: ["key sk-abc123"], n: 1 })).toEqual({ a: ["key [REDACTED]"], n: 1 });
  });
});

describe("createGateClient (library mode, no gateway server)", () => {
  it("enforces policy + redaction over a ConnectionConfig upstream", async () => {
    const mock = new MockMCPServer({
      tools: [
        { name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) },
        { name: "nuke", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "boom" }] }) },
      ],
    });
    const audit: string[] = [];
    const gate = await createGateClient({
      upstreams: { up: { transport: mock.transport } },
      policy: { denyDestructive: true },
      redact: [{ pattern: /sk-[a-z0-9]+/g }],
      audit: (e) => audit.push(`${e.target}:${e.outcome}`),
    });
    const ok = (await gate.client.callTool("echo", { msg: "token sk-abc9" })) as { content: { text: string }[] };
    expect(ok.content[0]!.text).toBe("token [REDACTED]");
    await expect(gate.client.callTool("nuke", {})).rejects.toThrow();
    expect(audit).toContain("echo:ok");
    expect(audit).toContain("nuke:denied");
    await gate.close();
  });

  it("rejects a stdio spec with a clear error instead of importing Node transports", () => {
    expect(() => resolveHttpUpstream({ command: "node" })).toThrow(/need Node/);
    expect(typeof resolveHttpUpstream({ url: "https://example.com/mcp" }).transport).toBe("function");
  });

  it("compilePolicy is the same function createGate uses", () => {
    expect(compilePolicy({ allow: ["a.*"] })({ kind: "call", server: "b", target: "x" } as never)).toBe("deny");
  });
});
