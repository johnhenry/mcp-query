import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src"); // consume mcp-query's TS source directly
const shared = resolve(here, "../shared/src"); // consume @app-shared's TS source directly
const sampleNotesDir = resolve(here, "sample-notes"); // abs path the proxy hands to the FS server

export default defineConfig({
  // Bake the absolute sample-notes path in at build time so the browser can hand it to
  // the filesystem MCP server (browsers can't resolve filesystem paths themselves).
  define: { __SAMPLE_NOTES_DIR__: JSON.stringify(sampleNotesDir) },
  plugins: [react()],
  // Aliases (most-specific first) so Vite/esbuild transpiles mcp-query + @app-shared source.
  resolve: {
    alias: [
      { find: "mcp-query/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "mcp-query/react", replacement: resolve(lib, "react/index.ts") },
      { find: "mcp-query/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "mcp-query", replacement: resolve(lib, "index.ts") },
      { find: /^@app-shared\/(.*)$/, replacement: resolve(shared, "$1") },
      { find: "@app-shared", replacement: resolve(shared, "react/index.tsx") },
    ],
  },
  // Pinned port (matches WEB_PORT in the `dev` script) so the proxy's printed URL is correct.
  // Allow importing source from the monorepo root.
  server: { port: Number(process.env.WEB_PORT) || 5177, strictPort: true, fs: { allow: [resolve(here, "../../")] } },
});
