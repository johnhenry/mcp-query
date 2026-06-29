import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src"); // consume mcp-query's TS source directly

export default defineConfig({
  // Aliases (most-specific first) so Vite/esbuild transpiles mcp-query's .ts source.
  resolve: {
    alias: [
      // Point at protocol.ts (DevtoolsHub) directly — index.ts also re-exports the React Panel.
      { find: "mcp-query/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "mcp-query/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "mcp-query", replacement: resolve(lib, "index.ts") },
    ],
  },
  // Pinned port (matches WEB_PORT in the `dev` script) so the proxy's printed URL is correct.
  // Allow importing source from the monorepo root.
  server: { port: Number(process.env.WEB_PORT) || 5173, strictPort: true, fs: { allow: [resolve(here, "../../")] } },
});
