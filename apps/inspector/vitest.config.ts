import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../packages/mcp-query/src");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@johnhenry/mcpq/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "@johnhenry/mcpq/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "@johnhenry/mcpq", replacement: resolve(lib, "index.ts") },
    ],
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
