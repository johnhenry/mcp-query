import { defineConfig } from "vitest/config";

// Opt-in stress suite (npm run test:stress). Separate from the default config on purpose:
// *.stress.ts files never match the default `test/**/*.test.{ts,tsx}` include, budgets are
// generous regression ceilings rather than benchmarks, and files run sequentially so one
// scenario's load doesn't skew another's timings.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/stress/**/*.stress.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      // --expose-gc lets memory scenarios force a full GC before measuring heap deltas.
      forks: { execArgv: ["--expose-gc"], singleFork: true },
    },
  },
});
