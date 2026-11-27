import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { runOp } from "../src/bench.js";
import { discoverOp, taskToTerminalOp, type RequestClient } from "../src/ops.js";
import { evaluateReport } from "../src/report.js";

/** A fake whose clock advances only when the op sleeps or the "server" takes time. */
function fakeTasks(statuses: string[], opts: { handleMs?: number; pollMs?: number } = {}) {
  let t = 0;
  const calls: string[] = [];
  let polls = 0;
  const client: RequestClient = {
    async request(req) {
      calls.push(req.method);
      if (req.method === "tools/call") {
        t += opts.handleMs ?? 5;
        polls = 0;
        return { taskId: "t1", status: "working", pollIntervalMs: 100 };
      }
      t += opts.pollMs ?? 1;
      return { taskId: "t1", status: statuses[Math.min(polls++, statuses.length - 1)], pollIntervalMs: 100 };
    },
  };
  return { client, calls, now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("taskToTerminalOp", () => {
  it("times the whole task (call + polling), not just the handle, and reports the handle phase", async () => {
    const f = fakeTasks(["working", "working", "completed"]);
    const op = taskToTerminalOp(f.client, "render", { id: 1 }, { now: f.now, sleep: f.sleep });
    const r = await runOp(op, { iterations: 3, warmup: 0, now: f.now });
    expect(r.ok).toBe(3);
    expect(f.calls.slice(0, 4)).toEqual(["tools/call", "tasks/get", "tasks/get", "tasks/get"]);
    // handle 5ms; then three polls: sleep 100 + 1ms each = 303ms; total 308ms.
    expect(r.summary.p50).toBe(308);
    expect(r.phases?.handle?.p50).toBe(5);
    expect(r.label).toBe("task:render");
  });

  it("counts a synchronous answer (no handle) as terminal immediately", async () => {
    const client: RequestClient = { request: async () => ({ content: [] }) };
    const r = await runOp(taskToTerminalOp(client, "plain", {}), { iterations: 2, warmup: 0 });
    expect(r.ok).toBe(2);
    expect(r.phases?.handle?.count).toBe(2);
  });

  it("counts failed and cancelled tasks, and timeouts, as errors", async () => {
    for (const end of ["failed", "cancelled"]) {
      const f = fakeTasks(["working", end]);
      const r = await runOp(taskToTerminalOp(f.client, "x", {}, { now: f.now, sleep: f.sleep }), { iterations: 2, warmup: 0, now: f.now });
      expect(r.failed).toBe(2);
      expect(r.ok).toBe(0);
    }
    const f = fakeTasks(["working"]);
    const r = await runOp(taskToTerminalOp(f.client, "x", {}, { timeoutMs: 250, now: f.now, sleep: f.sleep }), { iterations: 1, warmup: 0, now: f.now });
    expect(r.failed).toBe(1);
  });

  it("declares the tasks extension on every request and falls back to --poll-interval", async () => {
    const seen: unknown[] = [];
    const client: RequestClient = {
      async request(req) {
        seen.push(req.params);
        return req.method === "tools/call" ? { taskId: "t", status: "working" } : { taskId: "t", status: "completed" };
      },
    };
    const slept: number[] = [];
    await taskToTerminalOp(client, "x", { a: 1 }, { pollIntervalMs: 7, sleep: async (ms) => void slept.push(ms) }).invoke();
    expect(slept).toEqual([7]);
    for (const p of seen) expect(JSON.stringify(p)).toContain("io.modelcontextprotocol/tasks");
  });

  it("renders phase rows without applying budgets to them", async () => {
    const f = fakeTasks(["completed"]);
    const r = await runOp(taskToTerminalOp(f.client, "render", {}, { now: f.now, sleep: f.sleep }), { iterations: 2, warmup: 0, now: f.now });
    const out = evaluateReport({ results: [r] }, { maxP95: 1000 });
    expect(out.text).toContain("task:render");
    expect(out.text).toContain("task:render [handle]");
    expect(out.passed).toBe(true);
  });

  it("runs end to end against a task-capable server (legacy era, which every SDK allows)", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "slow", task: true, taskDelayMs: 40, handler: () => ({ content: [{ type: "text", text: "done" }] }) }] }, { era: "legacy" });
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(mock.transport());
    const r = await runOp(taskToTerminalOp(client as unknown as RequestClient, "slow", {}, { pollIntervalMs: 10 }), { iterations: 3, warmup: 0 });
    expect(r.failed).toBe(0);
    expect(r.summary.p50).toBeGreaterThanOrEqual(35); // waited for the work, not just the handle
    expect(r.phases!.handle!.p50).toBeLessThan(r.summary.p50);
    await client.close();
    mock.close();
  });
});

describe("discoverOp", () => {
  it("measures server/discover on a 2026-07-28 connection", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: () => ({ content: [] }) }] }, { era: "modern" });
    const client = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await client.connect(mock.transport());
    const r = await runOp(discoverOp(client as never), { iterations: 5, warmup: 1 });
    expect(r.label).toBe("server/discover");
    expect(r.ok).toBe(5);
    expect(r.failed).toBe(0);
    await client.close();
    mock.close();
  });

  it("fails clearly on a legacy connection", async () => {
    const op = discoverOp({ discover: async () => ({}), getProtocolEra: () => "legacy" });
    await expect(op.invoke()).rejects.toThrow(/2026-07-28 connection/);
    const r = await runOp(op, { iterations: 2, warmup: 0 });
    expect(r.failed).toBe(2);
  });
});
