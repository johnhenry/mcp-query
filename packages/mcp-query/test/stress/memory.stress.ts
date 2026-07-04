// GC / memory pressure: 10k subscribe/unsubscribe churn and 100 connect/close cycles must
// return the heap to (near) baseline — leaked listeners, timers, or connections show up as
// monotonic growth here long before they take down a real server process.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { CacheKey } from "../../src/core/keys.js";
import { heapAfterGc } from "./helpers.js";

const MB = 1024 * 1024;

describe("memory pressure", () => {
  it("10k subscribe/unsubscribe churn returns to baseline", async () => {
    const server = new MockMCPServer({
      resources: [{ uri: "mem://doc", read: () => ({ text: "x" }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    await client.readResource("mem://doc");
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://doc" };

    const before = await heapAfterGc();
    for (let i = 0; i < 10_000; i++) {
      const unsub = client.cache.subscribe(key, () => {});
      unsub();
    }
    const after = await heapAfterGc();
    const growth = (after - before) / MB;
    // eslint-disable-next-line no-console
    console.info(`[stress] heap growth after 10k sub/unsub churn: ${growth.toFixed(2)}MB`);
    expect(growth).toBeLessThan(5);

    await client.close();
  });

  it("100 connect/close cycles don't leak connections or listeners", async () => {
    const server = new MockMCPServer({
      tools: [{ name: "t", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
    });

    // Warm-up cycle so module-level lazies don't count against the baseline.
    {
      const c = new MCPClient({ servers: { s: { transport: server.transport } } });
      await c.connect();
      await c.callTool("t", {});
      await c.close();
    }

    const before = await heapAfterGc();
    for (let i = 0; i < 100; i++) {
      const c = new MCPClient({ servers: { s: { transport: server.transport } } });
      await c.connect();
      await c.callTool("t", { i });
      await c.close();
    }
    const after = await heapAfterGc();
    const growth = (after - before) / MB;
    // eslint-disable-next-line no-console
    console.info(`[stress] heap growth after 100 connect/close cycles: ${growth.toFixed(2)}MB`);
    expect(growth).toBeLessThan(8);
  });

  it("10k distinct short-lived cache keys stay bounded by bookkeeping, not payloads", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "lookup",
          annotations: { readOnlyHint: true },
          handler: (args) => ({ content: [{ type: "text", text: `v-${args.i}` }] }),
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const before = await heapAfterGc();
    for (let i = 0; i < 10_000; i++) {
      await client.queryTool("lookup", { i });
    }
    const after = await heapAfterGc();
    const growth = (after - before) / MB;
    // 10k tiny entries: generous ceiling; catches per-entry heavyweight retention.
    // eslint-disable-next-line no-console
    console.info(`[stress] heap growth after 10k distinct toolResult keys: ${growth.toFixed(2)}MB`);
    expect(growth).toBeLessThan(50);

    await client.close();
  });
});
