import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src");
const shared = resolve(here, "../shared/src");

export default defineConfig({
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
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
