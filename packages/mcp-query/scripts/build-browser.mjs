// Build dist/browser/mcp-query.browser.js: one self-contained ESM file for browsers.
// Run after `tsc` (it bundles the compiled dist/ and the mcp-gate browser entry source).
// Usage: node scripts/build-browser.mjs [--meta <path>]  (--meta writes the esbuild metafile)
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const outfile = root("dist/browser/mcp-query.browser.js");

// mcp-gate imports the published names of this package; point them at the freshly built
// dist/ so the bundle holds exactly one copy of MCPClient.
const alias = {
  "@johnhenry/mcp-query/server": root("dist/server/index.js"),
  "@johnhenry/mcp-query": root("dist/index.js"),
};

const metaIdx = process.argv.indexOf("--meta");
mkdirSync(root("dist/browser"), { recursive: true });
const result = await build({
  entryPoints: [root("scripts/browser-entry.js")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["browser"],
  target: "es2022",
  minify: true,
  legalComments: "none",
  alias,
  metafile: true,
  logLevel: "warning",
});

const bad = Object.keys(result.metafile.inputs).filter((i) => /(^|\/)node:|cross-spawn|\/stdio\b/.test(i));
if (bad.length) throw new Error(`browser bundle pulled in Node-only modules: ${bad.join(", ")}`);

// Type surface: the core + transports from this package. The gate parts are typed by
// `@johnhenry/mcp-gate` itself (import types from there).
writeFileSync(
  root("dist/browser/mcp-query.browser.d.ts"),
  `export * from "../index.js";
export { SSEClientTransport, StreamableHTTPClientTransport, InMemoryTransport, UnauthorizedError } from "../transports.js";
// Gate exports (createGateClient, compilePolicy, redact, ...) are runtime-only here; their types
// come from "@johnhenry/mcp-gate".
`,
);
if (metaIdx > 0) writeFileSync(process.argv[metaIdx + 1], JSON.stringify(result.metafile));
console.log(`built ${outfile}`);
