# mcp-bench

**Latency & throughput benchmarking for MCP servers**, with optional perf budgets for CI.

Point it at a server (local or hosted), pick the calls to exercise, and it reports p50/p95/p99
latency, throughput, and error rate per operation — and fails the build if you blow a budget.

```
operation    calls   err       p50       p95       p99       max      rps
tools/list     200    0%     4.4ms     8.6ms    12.3ms    14.6ms      792
tool:echo      200    0%     0.9ms     1.2ms     1.5ms     1.5ms     4438
✓ within budget
```

It reuses [`@mcp-query/contract`](../mcp-contract)'s connect path, so it benchmarks **local
(stdio)** or **hosted (Streamable HTTP / OAuth)** servers with the same flags.

## Use

```bash
# local server, a tool call, some load, and a p95 budget
npx tsx packages/mcp-bench/src/cli.ts \
  --command npx --args "-y @modelcontextprotocol/server-everything" \
  --call 'echo:{"message":"hi"}' \
  --concurrency 4 --iterations 200 --warmup 5 \
  --max-p95 250 --max-error-rate 0

# hosted server (reuses cached OAuth from `mcp-contract auth`)
npx tsx packages/mcp-bench/src/cli.ts --url https://host/mcp --duration 10
```

| Flag | Meaning |
|---|---|
| `--command` / `--args` / `--url` | target (stdio or Streamable HTTP); `--bearer` / `--header` for auth |
| `--call name:json` | benchmark a tool call (repeatable) |
| `--read-only` | also benchmark every read-only tool that takes no required args |
| `--concurrency N` | parallel callers per op (default 1) |
| `--iterations N` | calls per op (default 20) — or `--duration S` for time-boxed |
| `--warmup N` | untimed calls before measuring (default 3) |
| `--max-p95 MS` / `--max-error-rate R` | budgets; exit non-zero if exceeded |

By default it benchmarks `tools/list` plus any `--call` ops. **Destructive tools are never
hammered automatically** — `--read-only` only adds tools annotated `readOnlyHint` with no
required inputs.

> ⚠ **Benchmarking sends real traffic.** Against a hosted server that's real load on someone
> else's infrastructure — mind rate limits and terms of service. Defaults are deliberately
> conservative (concurrency 1, 20 iterations).

## Programmatic API

```ts
import { benchmark, evaluateReport } from "@mcp-query/bench";

const report = await benchmark(
  [{ label: "tools/list", invoke: () => client.listTools() }],
  { concurrency: 8, durationMs: 5000, warmup: 3 },
);
const { text, passed } = evaluateReport(report, { maxP95: 200, maxErrorRate: 0 });
console.log(text);
if (!passed) process.exit(1);
```

`benchmark(ops, opts)` is generic over an `invoke` thunk (MCP-agnostic and deterministically
testable); `summarize(samples)` and `evaluateReport(report, budget)` are exported too.

## Family

| Project | Role |
|---|---|
| mcp-query | consume MCP |
| mcp-gate | govern at runtime |
| mcp-contract | guard the interface in CI (drift) |
| mcp-lint | lint surface quality in CI |
| mcp-docs | generate reference docs |
| **mcp-bench** | **benchmark latency/throughput + perf budgets** |
| mcp-record | freeze real traffic as fixtures |

## Tests

```bash
npx vitest run   # percentiles, worker-pool iteration/error accounting, a real-client bench, budget eval
```

## Status

MVP (`private: true`). Roadmap: latency histograms / sparklines, warmup-vs-measured split,
JSON output, and a regression mode (compare two runs).
