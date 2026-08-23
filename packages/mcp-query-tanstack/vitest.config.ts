import { defineConfig } from "vitest/config";

// mcp-query-tanstack consumes mcp-query/@tanstack/react-query via relative source paths
// (monorepo dev), so no aliases needed.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
