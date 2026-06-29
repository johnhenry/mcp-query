#!/usr/bin/env node
// mcp-bench CLI — latency/throughput benchmark for an MCP server, with optional perf budgets.
//
//   mcp-bench --command npx --args "-y @modelcontextprotocol/server-everything" \
//             --call 'echo:{"message":"hi"}' --concurrency 4 --iterations 200
//   mcp-bench --url https://host/mcp --max-p95 250 --max-error-rate 0
//
// By default it benchmarks `tools/list` plus any --call ops. Destructive tools are never
// hammered automatically. Exits non-zero if a --max-* budget is exceeded.
//
// ⚠  Benchmarking sends REAL traffic. Against a hosted server that means real load on
//    someone else's infra — mind rate limits and terms of service.

import { connectClient, resolveConnect, captureContract } from "../../mcp-contract/src/index.js";
import { benchmark, type BenchOp } from "./bench.js";
import { evaluateReport, type Budget } from "./report.js";

function parseArgs(argv: string[]): { flags: Record<string, string>; headers: string[]; calls: string[] } {
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  const calls: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a === "--call") calls.push(argv[++i] ?? "");
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return { flags, headers, calls };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { flags, headers, calls } = parseArgs(argv);
  if (flags.url) console.error("⚠  benchmarking a hosted server sends real traffic — mind rate limits & ToS.\n");

  const { client, close } = await connectClient({ ...resolveConnect(flags, headers), clientName: "mcp-bench" });
  try {
    const ops: BenchOp[] = [{ label: "tools/list", invoke: () => client.listTools() }];

    for (const spec of calls) {
      const i = spec.indexOf(":");
      const name = i === -1 ? spec : spec.slice(0, i);
      const args = i === -1 ? {} : (JSON.parse(spec.slice(i + 1)) as Record<string, unknown>);
      ops.push({ label: `tool:${name}`, invoke: () => client.callTool({ name, arguments: args }) });
    }

    // --read-only: also benchmark every read-only tool that takes no required args (safe to call blind).
    if ("read-only" in flags) {
      const contract = await captureContract(client);
      for (const t of contract.tools) {
        if (t.annotations?.readOnlyHint && !t.inputSchema?.required?.length) {
          ops.push({ label: `tool:${t.name}`, invoke: () => client.callTool({ name: t.name, arguments: {} }) });
        }
      }
    }

    const report = await benchmark(ops, {
      concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
      iterations: flags.iterations ? Number(flags.iterations) : undefined,
      durationMs: flags.duration ? Number(flags.duration) * 1000 : undefined,
      warmup: flags.warmup ? Number(flags.warmup) : undefined,
    });

    const budget: Budget = {};
    if (flags["max-p95"]) budget.maxP95 = Number(flags["max-p95"]);
    if (flags["max-error-rate"]) budget.maxErrorRate = Number(flags["max-error-rate"]);

    const evaluated = evaluateReport(report, budget, { color: process.stderr.isTTY });
    console.error(evaluated.text);
    await close();
    process.exit(evaluated.passed ? 0 : 1);
  } catch (e) {
    await close();
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error("[mcp-bench]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
