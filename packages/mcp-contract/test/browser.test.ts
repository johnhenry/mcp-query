import { describe, it, expect } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const src = (f: string) => fileURLToPath(new URL(`../src/${f}`, import.meta.url));

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
    const bad = inputs.filter((i) => /node:|cross-spawn|cli\.ts|oauth\.ts|registry\.ts|connect\.ts|\/stdio/.test(i));
    expect(bad).toEqual([]);
  });

  it("the bundled browser entry diffs schemas and contracts with no Node globals", async () => {
    const { code } = await bundleForBrowser("index.browser.ts");
    const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
    const m = (await import(/* @vite-ignore */ url)) as typeof import("../src/index.browser.js");
    const before = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const after = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] };
    const changes = m.diffSchema(before, after, "in");
    expect(changes.some((c) => c.level === "breaking")).toBe(true);
    expect(typeof m.formatDiff).toBe("function");
    expect(typeof m.mockFromContract).toBe("function");
  });
});
