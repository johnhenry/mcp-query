// Parallel tool-call storm: 500 concurrent callTool with distinct args, then 500
// identical-key queryTool. Everything must settle without unhandled rejections, identical
// query keys must dedupe to a single upstream call, and per-call latency stays in budget.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { BUDGET, percentiles, tick } from "./helpers.js";

const CALLS = 500;

describe("parallel call storm", () => {
  it("500 concurrent callTool settle correctly", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "echo",
          annotations: { readOnlyHint: true },
          handler: async (args) => {
            await tick(1);
            return { content: [{ type: "text", text: String(args.i) }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const durations: number[] = [];
    const results = await Promise.allSettled(
      Array.from({ length: CALLS }, async (_, i) => {
        const t0 = performance.now();
        const r = (await client.callTool("echo", { i })) as { content: Array<{ text: string }> };
        durations.push(performance.now() - t0);
        return r.content[0]?.text;
      }),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>[];
    expect(fulfilled.length).toBe(CALLS);
    // Every distinct call reached the server and returned its own payload.
    expect(new Set(fulfilled.map((r) => r.value)).size).toBe(CALLS);
    expect(server.callLog.length).toBe(CALLS);

    const p = percentiles(durations);
    expect(p.p95).toBeLessThan(BUDGET.parallel500P95Ms);

    await client.close();
  });

  it("500 identical-key queryTool dedupe in-flight to one upstream call", async () => {
    let handled = 0;
    const server = new MockMCPServer({
      tools: [
        {
          name: "slow-read",
          annotations: { readOnlyHint: true },
          handler: async () => {
            handled++;
            await tick(50);
            return { content: [{ type: "text", text: "shared" }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const results = await Promise.all(
      Array.from({ length: CALLS }, () => client.queryTool("slow-read", { q: "same" })),
    );
    expect(results.length).toBe(CALLS);
    // In-flight dedup: identical (tool, argsHash) collapse to one server round-trip.
    expect(handled).toBe(1);

    await client.close();
  });
});
