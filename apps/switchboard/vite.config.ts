import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src"); // consume mcp-query's TS source directly
const shared = resolve(here, "../shared/src"); // consume @app-shared's TS source directly

export default defineConfig({
  // Bake absolute paths in at build time: the browser hands them to the WS proxy, which
  // spawns the gate sidecar (`tsx <gate-cli> <gate-config>`) — same trick as notebook's
  // __SAMPLE_NOTES_DIR__.
  define: {
    __GATE_CLI__: JSON.stringify(resolve(here, "../../packages/mcp-gate/src/cli.ts")),
    __GATE_CONFIG__: JSON.stringify(resolve(here, "gate.config.ts")),
  },
  plugins: [react()],
  // Aliases (most-specific first) so Vite/esbuild transpiles mcp-query + @app-shared source.
  resolve: {
    alias: [
      { find: "mcpq/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "mcpq/react", replacement: resolve(lib, "react/index.ts") },
      { find: "mcpq/server", replacement: resolve(lib, "server/index.ts") },
      { find: "mcpq/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "mcpq", replacement: resolve(lib, "index.ts") },
      { find: /^@app-shared\/(.*)$/, replacement: resolve(shared, "$1") },
      { find: "@app-shared", replacement: resolve(shared, "react/index.tsx") },
    ],
  },
  // Pinned port (matches WEB_PORT in the `dev` script) so the proxy's printed URL is correct.
  // Allow importing source from the monorepo root.
  server: { port: Number(process.env.WEB_PORT) || 5180, strictPort: true, fs: { allow: [resolve(here, "../../")] } },
});
