import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../../src");

export default defineConfig({
  resolve: {
    alias: [
      { find: "mcp-query/devtools", replacement: resolve(lib, "devtools/protocol.ts") },
      { find: "mcp-query/webmcp", replacement: resolve(lib, "webmcp/index.ts") },
      { find: "mcp-query", replacement: resolve(lib, "index.ts") },
    ],
  },
  test: {
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
  },
});
