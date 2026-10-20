// Build the single self-contained browser ESM bundle (#64): <outDir>/mcp-query.js (readable)
// and mcp-query.min.js, plus sizes.json. Nothing is left external, so one `import` of the
// file in a browser makes no further requests. `npm run build` runs this against dist/.
import { build } from "esbuild";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function buildBundle({ entry = `${root}dist/browser.js`, outDir = `${root}dist/bundle`, name = "mcp-query" } = {}) {
  mkdirSync(outDir, { recursive: true });
  const common = { entryPoints: [entry], bundle: true, format: "esm", platform: "browser", target: "es2022", conditions: ["browser"], logLevel: "warning" };
  await build({ ...common, outfile: `${outDir}/${name}.js` });
  await build({ ...common, minify: true, outfile: `${outDir}/${name}.min.js` });
  const size = (f) => {
    const buf = readFileSync(`${outDir}/${f}`);
    return { file: f, bytes: buf.length, gzip: gzipSync(buf).length, brotli: brotliCompressSync(buf).length };
  };
  const sizes = [size(`${name}.js`), size(`${name}.min.js`)];
  writeFileSync(`${outDir}/sizes.json`, JSON.stringify(sizes, null, 2) + "\n");
  return sizes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildBundle(), null, 2));
