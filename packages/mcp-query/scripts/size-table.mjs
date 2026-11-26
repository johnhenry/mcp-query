// Prints the browser bundle's size table (markdown). With --write, replaces the block between
// <!-- size-table:start --> and <!-- size-table:end --> in README.md.
// Builds the bundle first (needs dist/ from `npm run build`'s tsc step).
import { gzipSync, brotliCompressSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const meta = join(mkdtempSync(join(tmpdir(), "mcpq-size-")), "meta.json");
execFileSync(process.execPath, [root("scripts/build-browser.mjs"), "--meta", meta], { stdio: "ignore" });

const out = readFileSync(root("dist/browser/mcp-query.browser.js"));
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const m = JSON.parse(readFileSync(meta, "utf8"));
const output = Object.values(m.outputs)[0];

const groups = new Map();
for (const [file, info] of Object.entries(output.inputs)) {
  const nm = file.split("node_modules/").pop();
  const key = file.includes("node_modules/")
    ? nm.startsWith("@") ? nm.split("/").slice(0, 2).join("/") : nm.split("/")[0]
    : file.includes("mcp-gate/") ? "@johnhenry/mcp-gate (browser parts)" : "@johnhenry/mcp-query (core)";
  groups.set(key, (groups.get(key) ?? 0) + info.bytesInOutput);
}
const rows = [...groups].sort((a, b) => b[1] - a[1]);

const lines = [
  "| File | Raw | gzip | brotli |",
  "| --- | ---: | ---: | ---: |",
  `| \`mcp-query.browser.js\` (minified, one file) | ${kb(out.length)} | ${kb(gzipSync(out, { level: 9 }).length)} | ${kb(brotliCompressSync(out).length)} |`,
  "",
  "Where the raw bytes come from:",
  "",
  "| Inlined package | Raw (minified) |",
  "| --- | ---: |",
  ...rows.map(([k, v]) => `| \`${k}\` | ${kb(v)} |`),
];
const table = lines.join("\n");

if (process.argv.includes("--write")) {
  const readme = root("README.md");
  const s = readFileSync(readme, "utf8");
  const re = /<!-- size-table:start -->[\s\S]*?<!-- size-table:end -->/;
  if (!re.test(s)) throw new Error("size-table markers not found in README.md");
  writeFileSync(readme, s.replace(re, `<!-- size-table:start -->\n${table}\n<!-- size-table:end -->`));
  console.log("README.md updated");
} else console.log(table);
