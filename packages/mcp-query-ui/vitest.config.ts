import { defineConfig } from "vitest/config";

// Resolves @johnhenry/mcp-query / mcp-gate through the workspace (their dist/ is built by turbo
// before `test`). DOM-touching tests opt into happy-dom via a per-file docblock.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.{ts,tsx}"], testTimeout: 15000 },
});
