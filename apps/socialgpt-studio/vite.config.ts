import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src"); // consume mcp-query's TS source directly
const shared = resolve(here, "../shared/src"); // consume @app-shared's TS source directly

export default defineConfig({
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
  // Allow importing source from the monorepo root, and proxy /mcp → the Deno/Node
  // backend (port 8787) so the React app can always call the relative url "/mcp".
  server: {
    fs: { allow: [resolve(here, "../../")] },
    proxy: {
      "/mcp": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
