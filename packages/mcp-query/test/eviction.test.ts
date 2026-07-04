// Cache eviction API: remove()/clear() plus per-read gcTime and write-time gc arming
// (previously only un-subscribe armed the timer, so imperative reads leaked entries).

import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MCPCache } from "../src/core/cache.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import type { CacheKey } from "../src/core/keys.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function server() {
  return new MockMCPServer({
    resources: [
      { uri: "mem://a", read: () => ({ text: "A" }) },
      { uri: "mem://b", read: () => ({ text: "B" }) },
    ],
  });
}

describe("cache eviction", () => {
  it("remove() evicts one entry and notifies subscribers", async () => {
    const client = new MCPClient({ servers: { s: { transport: server().transport } } });
    await client.connect();
    await client.readResource("mem://a");
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://a" };

    let notified = 0;
    const unsub = client.cache.subscribe(key, () => notified++);
    expect(client.cache.getSnapshot(key)).toBeDefined();

    client.cache.remove(key);
    expect(client.cache.getSnapshot(key)).toBeUndefined();
    expect(notified).toBeGreaterThan(0);
    unsub();
    await client.close();
  });

  it("clear() evicts everything; clear({ partition }) only that tenant", async () => {
    const client = new MCPClient({ servers: { s: { transport: server().transport } } });
    await client.connect();
    await client.scope({ partition: "t1" }).readResource("mem://a");
    await client.scope({ partition: "t2" }).readResource("mem://a");
    expect(client.cache.dehydrate().entries.length).toBeGreaterThanOrEqual(2);

    client.cache.clear({ partition: "t1" });
    const partitions = client.cache
      .dehydrate()
      .entries.map((e) => (e.cacheKey as { partition?: string }).partition);
    expect(partitions).not.toContain("t1");
    expect(partitions).toContain("t2");

    client.cache.clear();
    expect(client.cache.dehydrate().entries.length).toBe(0);
    await client.close();
  });

  it("per-read gcTime evicts unobserved entries after the deadline", async () => {
    const client = new MCPClient({ servers: { s: { transport: server().transport } } });
    await client.connect();
    await client.readResource("mem://b", { gcTime: 30 });
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://b" };
    expect(client.cache.getSnapshot(key)).toBeDefined();

    await tick(80);
    expect(client.cache.getSnapshot(key)).toBeUndefined();
    await client.close();
  });

  it("subscribed entries survive their gcTime", async () => {
    const cache = new MCPCache();
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://kept" };
    const unsub = cache.subscribe(key, () => {});
    cache.write(key, { v: 1 }, { gcTime: 20 });
    await tick(60);
    expect(cache.getSnapshot(key)?.data).toEqual({ v: 1 });
    unsub();
  });
});
