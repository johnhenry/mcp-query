// Render a benchmark report as a table, and evaluate optional perf budgets (CI gate).

import type { BenchReport, OpResult } from "./bench.js";

export interface Budget {
  /** Fail if any op's p95 latency (ms) exceeds this. */
  maxP95?: number;
  /** Fail if any op's error rate (0–1) exceeds this. */
  maxErrorRate?: number;
}

export interface Evaluated {
  text: string;
  passed: boolean;
  failures: string[];
}

const ms = (n: number) => `${n.toFixed(1)}ms`;
const pad = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

function violations(r: OpResult, budget: Budget): string[] {
  const out: string[] = [];
  if (budget.maxP95 !== undefined && r.summary.p95 > budget.maxP95) out.push(`${r.label}: p95 ${ms(r.summary.p95)} > ${ms(budget.maxP95)}`);
  if (budget.maxErrorRate !== undefined && r.errorRate > budget.maxErrorRate) out.push(`${r.label}: error rate ${(r.errorRate * 100).toFixed(1)}% > ${(budget.maxErrorRate * 100).toFixed(1)}%`);
  return out;
}

export function evaluateReport(report: BenchReport, budget: Budget = {}, opts: { color?: boolean } = {}): Evaluated {
  const c = opts.color ?? false;
  const red = (s: string) => (c ? `\x1b[31m${s}\x1b[0m` : s);
  const green = (s: string) => (c ? `\x1b[32m${s}\x1b[0m` : s);

  const labelW = Math.max(9, ...report.results.map((r) => r.label.length));
  const header = `${pad("operation", labelW)}  ${padL("calls", 6)} ${padL("err", 5)} ${padL("p50", 9)} ${padL("p95", 9)} ${padL("p99", 9)} ${padL("max", 9)} ${padL("rps", 8)}`;
  const rows = report.results.map((r) => {
    const err = `${(r.errorRate * 100).toFixed(0)}%`;
    return `${pad(r.label, labelW)}  ${padL(String(r.ok + r.failed), 6)} ${padL(err, 5)} ${padL(ms(r.summary.p50), 9)} ${padL(ms(r.summary.p95), 9)} ${padL(ms(r.summary.p99), 9)} ${padL(ms(r.summary.max), 9)} ${padL(r.rps.toFixed(0), 8)}`;
  });

  const failures = report.results.flatMap((r) => violations(r, budget));
  const passed = failures.length === 0;
  const footer = Object.keys(budget).length
    ? "\n" + (passed ? green("✓ within budget") : red(`✗ budget exceeded:\n  ${failures.join("\n  ")}`))
    : "";
  return { text: [header, ...rows].join("\n") + footer, passed, failures };
}
