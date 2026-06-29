import { defineConfig } from "vitest/config";

// mcp-contract consumes mcp-query via relative source paths (monorepo dev), so no aliases needed.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
