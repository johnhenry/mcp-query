import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src");
const shared = resolve(here, "../shared/src");

export default defineConfig({
  plugins: [react()],
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
  server: {
    fs: { allow: [resolve(here, "../../")] },
    // Proxy Ollama to avoid browser CORS in dev (the box runs Ollama on :11434).
    proxy: { "/ollama": { target: "http://localhost:11434", changeOrigin: true, rewrite: (p) => p.replace(/^\/ollama/, "") } },
  },
});
