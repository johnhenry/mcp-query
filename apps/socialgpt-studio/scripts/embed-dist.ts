// Generate backend/dist-embed.json — { relativePath: base64 } for every file under dist/.
// backend/main.ts imports this JSON statically, so `deno compile` (via `deno desktop`)
// follows it and ships the whole SPA INSIDE the binary. This sidesteps `deno desktop`'s
// experimental `--include` (which breaks entry resolution on macOS) and the runtime
// `Deno.readFile("../dist")` that a compiled binary can't satisfy. Run before `deno desktop`.

const appRoot = new URL("../", import.meta.url); // apps/socialgpt-studio/
const distDir = new URL("dist/", appRoot);
const outFile = new URL("backend/dist-embed.json", appRoot);

function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const files: Record<string, string> = {};
async function walk(dir: URL, prefix: string): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) await walk(new URL(entry.name + "/", dir), prefix + entry.name + "/");
    else files[prefix + entry.name] = base64(await Deno.readFile(new URL(entry.name, dir)));
  }
}

try {
  await walk(distDir, "");
} catch {
  console.error(`embed-dist: ${distDir.pathname} not found — run \`npm run build -w @mcp-query/socialgpt-studio\` first`);
  Deno.exit(1);
}
await Deno.writeTextFile(outFile, JSON.stringify(files));
console.error(`embed-dist: embedded ${Object.keys(files).length} files → backend/dist-embed.json`);
