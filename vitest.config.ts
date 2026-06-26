import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default to node; React hook tests opt into happy-dom via a per-file
    // `// @vitest-environment happy-dom` docblock.
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 15000,
  },
});
