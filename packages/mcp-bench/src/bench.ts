// The benchmark runner — generic over an `invoke` thunk so it's MCP-agnostic and
// deterministically testable. Each op is run on its own: a warmup, then a worker pool of
// `concurrency` callers draining either an iteration budget or a wall-clock duration,
// recording per-call latency and errors.

import { summarize, type Summary } from "./stats.js";

export interface BenchOp {
  label: string;
  invoke: () => Promise<unknown>;
}

export interface BenchOptions {
  /** Parallel callers per op. Default 1. */
  concurrency?: number;
  /** Total successful+failed calls per op (ignored if durationMs is set). Default 20. */
  iterations?: number;
  /** Run each op for this long instead of a fixed iteration count. */
  durationMs?: number;
  /** Untimed calls before measuring (JIT / connection warm). Default 3. */
  warmup?: number;
  /** Injected clock (ms) for deterministic tests. Default performance.now. */
  now?: () => number;
}

export interface OpResult {
  label: string;
  summary: Summary;
  ok: number;
  failed: number;
  errorRate: number;
  /** Successful calls per second over the measured wall time. */
  rps: number;
  wallMs: number;
}

export async function runOp(op: BenchOp, opts: BenchOptions = {}): Promise<OpResult> {
  const now = opts.now ?? (() => performance.now());
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const warmup = opts.warmup ?? 3;

  for (let i = 0; i < warmup; i++) await op.invoke().catch(() => {});

  const samples: number[] = [];
  let ok = 0;
  let failed = 0;
  const deadline = opts.durationMs ? now() + opts.durationMs : Infinity;
  let remaining = opts.durationMs ? Infinity : opts.iterations ?? 20;

  const start = now();
  const worker = async (): Promise<void> => {
    // JS is single-threaded, so the remaining-- / deadline checks are race-free.
    while (now() < deadline && remaining > 0) {
      if (remaining !== Infinity) remaining--;
      const t0 = now();
      try {
        await op.invoke();
        samples.push(now() - t0);
        ok++;
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = now() - start;

  const total = ok + failed;
  return {
    label: op.label,
    summary: summarize(samples),
    ok,
    failed,
    errorRate: total ? failed / total : 0,
    rps: wallMs > 0 ? ok / (wallMs / 1000) : 0,
    wallMs,
  };
}

export interface BenchReport {
  results: OpResult[];
}

/** Benchmark each op in sequence (so they don't contend for the same connection). */
export async function benchmark(ops: BenchOp[], opts: BenchOptions = {}): Promise<BenchReport> {
  const results: OpResult[] = [];
  for (const op of ops) results.push(await runOp(op, opts));
  return { results };
}
