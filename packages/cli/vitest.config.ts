import { defineConfig } from "vitest/config";

// consumes mcp-query / @mcp-query/* via relative source paths (monorepo dev), so no aliases.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
