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
      { find: "@johnhenry/mcpq/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "@johnhenry/mcpq/testing", replacement: resolve(lib, "testing/mockServer.ts") },
      { find: "@johnhenry/mcpq/react", replacement: resolve(lib, "react/index.ts") },
      { find: "@johnhenry/mcpq/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "@johnhenry/mcpq", replacement: resolve(lib, "index.ts") },
      { find: /^@app-shared\/(.*)$/, replacement: resolve(shared, "$1") },
      { find: "@app-shared", replacement: resolve(shared, "react/index.tsx") },
    ],
  },
  // Pinned port (matches WEB_PORT in the `dev` script) so the proxy's printed URL is correct.
  // Allow importing source from the monorepo root.
  server: { port: Number(process.env.WEB_PORT) || 5175, strictPort: true, fs: { allow: [resolve(here, "../../")] } },
});
