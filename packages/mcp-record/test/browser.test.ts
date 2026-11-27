import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";

const src = (f: string) => fileURLToPath(new URL(`../src/${f}`, import.meta.url));

// Bundle an entry for a browser platform. esbuild fails on unresolved `node:` builtins (platform
// "browser" does not provide them), and the metafile lets us assert none were pulled in at all.
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
  return { code: r.outputFiles[0]!.text, inputs: Object.keys(r.metafile.inputs) };
}

describe("browser-safe entry (#67)", { timeout: 60_000 }, () => {
  it("index.browser.ts bundles for a browser with no Node-only modules", async () => {
    const { inputs } = await bundleForBrowser("index.browser.ts");
    const bad = inputs.filter((i) => /node:|cross-spawn|cli\.ts|\/stdio|mcp-contract/.test(i));
    expect(bad).toEqual([]);
  });

  it("the bundled browser entry records, seals and replays with no Node globals", async () => {
    const { code } = await bundleForBrowser("index.browser.ts");
    const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
    const m = (await import(/* @vite-ignore */ url)) as typeof import("../src/index.browser.js");
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] });
    const { Client } = await import("@modelcontextprotocol/client");

    const cassette = m.createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rec.connect(m.recordTransport(mock.transport(), cassette));
    await rec.callTool({ name: "echo", arguments: { msg: "hi" } });
    await rec.close();
    m.sealCassette(cassette);
    expect(cassette.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(m.loadCassette(JSON.stringify(cassette)).integrity).toBe(cassette.integrity);

    const rp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rp.connect(m.replayTransport(cassette)());
    const out = (await rp.callTool({ name: "echo", arguments: { msg: "hi" } })) as { content: { text: string }[] };
    expect(out.content[0]!.text).toBe("hi");
    await rp.close();
  });
});
