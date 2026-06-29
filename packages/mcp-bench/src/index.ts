// mcp-bench — latency/throughput benchmarking for MCP servers, with optional perf budgets.
// Reuses mcp-contract's connect path, so it benchmarks local (stdio) or hosted (HTTP/OAuth)
// servers alike. The runner is generic over an `invoke` thunk and deterministically testable.

export { benchmark, runOp, type BenchOp, type BenchOptions, type OpResult, type BenchReport } from "./bench.js";
export { summarize, type Summary } from "./stats.js";
export { evaluateReport, type Budget, type Evaluated } from "./report.js";
