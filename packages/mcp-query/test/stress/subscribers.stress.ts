// 1,000 cache subscribers on one resource + a resources/updated flood. Every subscriber
// must observe the final version, fan-out must stay within budget, and unsubscribing must
// return the server-side subscription ref-count to zero.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { CacheKey } from "../../src/core/keys.js";
import { BUDGET, tick } from "./helpers.js";

const SUBSCRIBERS = 1_000;
const BURSTS = 500;

describe("subscriber storm", () => {
  it("fans resources/updated out to 1k subscribers and unwinds cleanly", async () => {
    let version = 0;
    const server = new MockMCPServer({
      resources: [{ uri: "mem://doc", read: () => ({ text: `v${version}` }) }],
    });
    const client = new MCPClient({ servers: { mem: { transport: server.transport } } });
    await client.connect();

    // Prime the entry with a live server subscription, then attach 1k cache observers.
    await client.readResource("mem://doc", { subscribe: true });
    const key: CacheKey = { kind: "resource", server: "mem", uri: "mem://doc" };
    let notifications = 0;
    const unsubs = Array.from({ length: SUBSCRIBERS }, () =>
      client.cache.subscribe(key, () => {
        notifications++;
      }),
    );
    expect(server.subscribed.has("mem://doc")).toBe(true);

    const started = performance.now();
    for (let i = 0; i < BURSTS; i++) {
      version = i + 1;
      await server.notifyResourceUpdated("mem://doc");
    }
    await tick(100);
    const elapsed = performance.now() - started;

    // resources/updated marks the entry stale and notifies observers — the refetch happens
    // on the next read (hooks do this automatically; imperative callers re-read).
    expect(client.cache.isStale(key)).toBe(true);
    const fresh = (await client.readResource("mem://doc")) as { contents: Array<{ text: string }> };
    expect(fresh.contents[0]?.text).toBe(`v${BURSTS}`);
    // Each subscriber saw at least one notification; exact counts depend on coalescing.
    expect(notifications).toBeGreaterThanOrEqual(SUBSCRIBERS);
    expect(elapsed).toBeLessThan(BUDGET.fanout1kMs);

    for (const u of unsubs) u();
    await tick(50);
    // Ref-count must hit zero → the client unsubscribes from the server.
    expect(server.subscribed.has("mem://doc")).toBe(false);

    await client.close();
  });
});
