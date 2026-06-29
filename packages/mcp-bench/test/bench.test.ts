import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { summarize } from "../src/stats.js";
import { runOp, benchmark } from "../src/bench.js";
import { evaluateReport } from "../src/report.js";

describe("summarize", () => {
  it("computes nearest-rank percentiles", () => {
    const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s.count).toBe(10);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(55);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(100);
  });
  it("handles an empty sample", () => {
    expect(summarize([]).count).toBe(0);
  });
});

describe("runOp", () => {
  it("runs the iteration budget across the worker pool and records latency", async () => {
    let calls = 0;
    const r = await runOp(
      { label: "noop", invoke: async () => void calls++ },
      { iterations: 50, concurrency: 5, warmup: 2 },
    );
    expect(calls).toBe(50 + 2); // iterations + warmup
    expect(r.ok).toBe(50);
    expect(r.failed).toBe(0);
    expect(r.summary.count).toBe(50);
    expect(r.errorRate).toBe(0);
  });

  it("counts failures and reports an error rate", async () => {
    const r = await runOp(
      { label: "boom", invoke: async () => { throw new Error("nope"); } },
      { iterations: 10, warmup: 0 },
    );
    expect(r.ok).toBe(0);
    expect(r.failed).toBe(10);
    expect(r.errorRate).toBe(1);
  });
});

describe("benchmark against a real MCP client", () => {
  it("measures tools/list and a tool call over an in-memory server", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] });
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(mock.transport());

    const report = await benchmark(
      [
        { label: "tools/list", invoke: () => client.listTools() },
        { label: "tool:echo", invoke: () => client.callTool({ name: "echo", arguments: { msg: "x" } }) },
      ],
      { iterations: 25, concurrency: 4, warmup: 1 },
    );
    expect(report.results.map((r) => r.label)).toEqual(["tools/list", "tool:echo"]);
    expect(report.results.every((r) => r.ok === 25 && r.failed === 0)).toBe(true);
    await client.close();
  });
});

describe("evaluateReport budgets", () => {
  const report = { results: [{ label: "op", summary: { count: 3, min: 1, max: 9, mean: 5, p50: 5, p95: 9, p99: 9 }, ok: 3, failed: 0, errorRate: 0, rps: 100, wallMs: 30 }] };
  it("passes within budget and fails when p95 exceeds it", () => {
    expect(evaluateReport(report, { maxP95: 10 }).passed).toBe(true);
    const bad = evaluateReport(report, { maxP95: 5 });
    expect(bad.passed).toBe(false);
    expect(bad.failures[0]).toContain("p95");
  });
});
