import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default to node; React hook tests opt into happy-dom via a per-file
    // `// @vitest-environment happy-dom` docblock.
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Panel.tsx is a UI skeleton; the CLIs are I/O wrappers verified by smoke tests.
      exclude: ["src/**/index.ts", "src/codegen/cli.ts"],
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
