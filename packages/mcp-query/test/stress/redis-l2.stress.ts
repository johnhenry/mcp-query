// Redis L2 CacheStore: two MCPClients ("nodes") linked through the same (fake or real)
// Redis. Node B must hydrate reads from node A's L2 writes without touching its upstream,
// a 1,000-tag invalidation storm must lose nothing, JSON must round-trip intact, and PX
// TTLs must expire entries. Runs on an in-process RedisLike fake by default; set
// REDIS_URL=redis://… to exercise a real ioredis connection instead.
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { createRedisCacheStore, type RedisLike } from "../../src/redis/index.js";
import { fakeRedisHub, tick } from "./helpers.js";

async function realRedis(): Promise<{ main: RedisLike; sub: RedisLike } | undefined> {
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  const { default: Redis } = (await import("ioredis" as string)) as { default: new (u: string) => RedisLike };
  return { main: new Redis(url), sub: new Redis(url) };
}

describe("redis L2 cache store", () => {
  it("node B reads node A's cached entry without touching its own upstream", async () => {
    const hub = fakeRedisHub();
    const real = await realRedis();
    const storeA = createRedisCacheStore(real?.main ?? hub.makeClient(), real?.sub ?? hub.makeClient(), { prefix: "t1:" });
    const storeB = createRedisCacheStore(real?.main ?? hub.makeClient(), real?.sub ?? hub.makeClient(), { prefix: "t1:" });

    let readsA = 0;
    let readsB = 0;
    const serverA = new MockMCPServer({
      resources: [{ uri: "mem://x", read: () => ({ text: `A-${++readsA}` }) }],
    });
    const serverB = new MockMCPServer({
      resources: [{ uri: "mem://x", read: () => ({ text: `B-${++readsB}` }) }],
    });
    const nodeA = new MCPClient({ servers: { s: { transport: serverA.transport } }, cacheStore: storeA });
    const nodeB = new MCPClient({ servers: { s: { transport: serverB.transport } }, cacheStore: storeB });
    await nodeA.connect();
    await nodeB.connect();

    const a = (await nodeA.readResource("mem://x")) as { contents: Array<{ text: string }> };
    expect(a.contents[0]?.text).toBe("A-1");
    await tick(20); // L2 write is fire-and-forget

    const b = (await nodeB.readResource("mem://x")) as { contents: Array<{ text: string }> };
    // Served from the shared L2 — node B's upstream must not have been read.
    expect(b.contents[0]?.text).toBe("A-1");
    expect(readsB).toBe(0);

    await nodeA.close();
    await nodeB.close();
  });

  it("a 1,000-tag invalidation storm loses nothing across nodes", async () => {
    const hub = fakeRedisHub();
    const storeA = createRedisCacheStore(hub.makeClient(), hub.makeClient(), { prefix: "t2:" });
    const storeB = createRedisCacheStore(hub.makeClient(), hub.makeClient(), { prefix: "t2:" });

    const received: string[][] = [];
    storeB.subscribeInvalidations!((tags) => received.push(tags));

    for (let i = 0; i < 1_000; i++) {
      await storeA.publishInvalidation!([`tag-${i}`, `shared-${i % 10}`]);
    }
    await tick(20);

    expect(received.length).toBe(1_000);
    const flat = new Set(received.flat());
    for (let i = 0; i < 1_000; i++) expect(flat.has(`tag-${i}`)).toBe(true);
  });

  it("JSON round-trip preserves structure and PX TTL expires entries", async () => {
    const hub = fakeRedisHub();
    const store = createRedisCacheStore(hub.makeClient(), undefined, { prefix: "t3:", ttlMs: 500 });

    const entry = {
      data: { nested: { deep: [1, "two", null, { three: true }] }, uni: "héllо ⚡" },
      tags: ["a", "b"],
      updatedAt: 12345,
    };
    await store.set("key1", entry);
    const roundTripped = await store.get("key1");
    expect(roundTripped).toEqual(entry);

    hub.advance(501);
    expect(await store.get("key1")).toBeUndefined();
  });
});
