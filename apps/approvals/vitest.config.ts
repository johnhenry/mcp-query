import { defineConfig } from "vitest/config";
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
      { find: "@johnhenry/mcp-query/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "@johnhenry/mcp-query/react", replacement: resolve(lib, "react/index.ts") },
      { find: "@johnhenry/mcp-query/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "@johnhenry/mcp-query", replacement: resolve(lib, "index.ts") },
      { find: /^@app-shared\/(.*)$/, replacement: resolve(shared, "$1") },
      { find: "@app-shared", replacement: resolve(shared, "react/index.tsx") },
    ],
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
