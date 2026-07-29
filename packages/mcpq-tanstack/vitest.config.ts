import { defineConfig } from "vitest/config";

// mcpq-tanstack consumes mcpq/@tanstack/react-query via relative source paths
// (monorepo dev), so no aliases needed.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
