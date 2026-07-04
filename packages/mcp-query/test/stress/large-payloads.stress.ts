// Large payloads through the cache: multi-MB resource reads must stay within a time
// budget, deep-equal re-reads must keep the SAME object reference (structural sharing —
// subscribers don't re-render), and superseded large payloads must become collectable
// rather than being retained by the cache.
//
// NOTE: MCPCache has no imperative eviction (no clear()/remove(); gcTime is per-entry and
// not exposed on ReadResourceOpts) — so the memory assertion routes 50 payloads through
// ONE key, where each write supersedes the last. See findings: cache eviction API gap.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { CacheKey } from "../../src/core/keys.js";
import { BUDGET, heapAfterGc } from "./helpers.js";

const MB = 1024 * 1024;

describe("large payloads", () => {
  it("reads a 25MB resource within budget and shares structure on re-read", async () => {
    const body = "x".repeat(25 * MB);
    const server = new MockMCPServer({
      resources: [{ uri: "mem://big", read: () => ({ text: body }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const t0 = performance.now();
    await client.readResource("mem://big", { staleTime: 0 });
    const first = performance.now() - t0;
    expect(first).toBeLessThan(BUDGET.largeReadMs);

    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://big" };
    const snap1 = client.cache.getSnapshot(key)?.data;
    // staleTime 0 → refetch; identical payload must keep the same reference.
    await client.readResource("mem://big", { staleTime: 0 });
    const snap2 = client.cache.getSnapshot(key)?.data;
    expect(snap2).toBe(snap1);

    await client.close();
  });

  it("50 superseding 5MB writes through one key don't accumulate in the heap", async () => {
    let generation = 0;
    const server = new MockMCPServer({
      resources: [
        {
          uri: "mem://feed",
          // Distinct 5MB payload per generation so structural sharing never kicks in.
          read: () => ({ text: `${generation}:`.padEnd(5 * MB, String.fromCharCode(97 + (generation % 26))) }),
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    await client.readResource("mem://feed", { staleTime: 0 });
    const before = await heapAfterGc();
    for (generation = 1; generation <= 50; generation++) {
      await client.readResource("mem://feed", { staleTime: 0 });
    }
    const after = await heapAfterGc();

    const growth = (after - before) / MB;
    // eslint-disable-next-line no-console
    console.info(`[stress] heap growth after 50 superseding 5MB payloads: ${growth.toFixed(1)}MB`);
    // Only the live payload (~5MB) plus bookkeeping may remain.
    expect(growth).toBeLessThan(25);

    await client.close();
  });
});
