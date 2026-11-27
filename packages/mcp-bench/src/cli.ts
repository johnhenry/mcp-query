#!/usr/bin/env node
// mcp-bench CLI — latency/throughput benchmark for an MCP server, with optional perf budgets.
//
//   mcp-bench --command npx --args "-y @modelcontextprotocol/server-everything" \
//             --call 'echo:{"message":"hi"}' --concurrency 4 --iterations 200
//   mcp-bench --command … --call 'echo(message: "hi")'      # function-call form works too
//   mcp-bench --url https://host/mcp --max-p95 250 --max-error-rate 0
//
// 2026-07-28 ops:
//   mcp-bench --url … --discover                      # server/discover latency (needs the default --era auto)
//   mcp-bench --url … --era auto --task 'render:{"id":1}' [--poll-interval 50] [--task-timeout 60]
//                                                     # time to the *terminal* task state; the time to the handle is shown as a [handle] row
//
// By default it benchmarks `tools/list` plus any --call ops. Destructive tools are never
// hammered automatically. Exits non-zero if a --max-* budget is exceeded.
//
// ⚠  Benchmarking sends REAL traffic. Against a hosted server that means real load on
//    someone else's infra — mind rate limits and terms of service.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectEra, parseEra, DEFAULT_ERA, resolveConnect, captureContract, parseCallSpec, rejectUnknownFlags } from "../../mcp-contract/src/index.js";
import { discoverOp, taskToTerminalOp, type DiscoverClient, type RequestClient } from "./ops.js";
import { benchmark, type BenchOp } from "./bench.js";
import { evaluateReport, type Budget } from "./report.js";

const KNOWN_FLAGS = [
  "server",
  "config",
  "command",
  "args",
  "url",
  "bearer",
  "header",
  "call",
  "concurrency",
  "iterations",
  "duration",
  "warmup",
  "max-p95",
  "max-error-rate",
  "read-only",
  "task",
  "poll-interval",
  "task-timeout",
  "discover",
  "era",
] as const;
const BOOLEAN_FLAGS = new Set(["discover", "read-only"]);

function parseArgs(argv: string[]): { flags: Record<string, string>; headers: string[]; calls: string[]; tasks: string[] } {
  const flags: Record<string, string> = {};
  const headers: string[] = [];
  const calls: string[] = [];
  const tasks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--header") headers.push(argv[++i] ?? "");
    else if (a === "--call") calls.push(argv[++i] ?? "");
    else if (a === "--task") tasks.push(argv[++i] ?? "");
    else if (a.startsWith("--") && BOOLEAN_FLAGS.has(a.slice(2))) flags[a.slice(2)] = "true";
    else if (a.startsWith("--")) flags[a.slice(2)] = argv[++i] ?? "";
  }
  return { flags, headers, calls, tasks };
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { flags, headers, calls, tasks } = parseArgs(argv);
  rejectUnknownFlags("mcp-bench", flags, KNOWN_FLAGS);
  // --call accepts colon+JSON ('tool:{"a":1}') or a function-call string ('tool(a: 1)');
  // parse before connecting so a bad spec fails fast.
  const parsedCalls = calls.map((spec) => parseCallSpec(spec));
  const parsedTasks = tasks.map((spec) => parseCallSpec(spec));
  const explicitEra = parseEra(flags.era);
  if ("discover" in flags && explicitEra === "legacy") throw new Error("--discover needs --era auto (server/discover is a 2026-07-28 request)");
  if (flags.url) console.error("⚠  benchmarking a hosted server sends real traffic — mind rate limits & ToS.\n");

  const connectOpts = { ...resolveConnect(flags, headers), clientName: "mcp-bench" };
  if ("discover" in flags && !explicitEra && connectOpts.era === "legacy") throw new Error("--discover needs a 2026-07-28 connection, but this server is pinned to era legacy in the registry; pass --era auto");
  const { client, close } = await connectEra(connectOpts, explicitEra ?? connectOpts.era ?? DEFAULT_ERA);
  try {
    const ops: BenchOp[] = [{ label: "tools/list", invoke: () => client.listTools() }];

    for (const { name, args } of parsedCalls) {
      ops.push({ label: `tool:${name}`, invoke: () => client.callTool({ name, arguments: args }) });
    }

    // --discover: server/discover latency (2026-07-28). --task: time to the *terminal* task state, not just the handle.
    if ("discover" in flags) ops.push(discoverOp(client as unknown as DiscoverClient));
    for (const { name, args } of parsedTasks) {
      ops.push(
        taskToTerminalOp(client as unknown as RequestClient, name, args, {
          ...(flags["poll-interval"] ? { pollIntervalMs: Number(flags["poll-interval"]) } : {}),
          ...(flags["task-timeout"] ? { timeoutMs: Number(flags["task-timeout"]) * 1000 } : {}),
        }),
      );
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

// An installed bin is a symlink, so compare real paths (a plain string compare never matches there).
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run().catch((e) => {
    console.error("[mcp-bench]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
