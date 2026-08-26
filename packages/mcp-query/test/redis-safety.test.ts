// Regression tests for the MEDIUM finding: unguarded JSON.parse on Redis L2 cache/pub-sub
// data. (1) A corrupted L2 cache entry must be treated as a miss and fall back to fetching
// fresh from origin, not fail the whole read. (2) A malformed pub/sub invalidation message
// must not crash the listener (it runs synchronously inside an ioredis event emitter).
// See: https://github.com/johnhenry/mcp-query/issues/33

import { describe, it, expect, vi, afterEach } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createRedisCacheStore } from "../src/redis/index.js";
import { serializeKey } from "../src/core/keys.js";
import { fakeRedisHub, tick } from "./stress/helpers.js";

describe("redis L2 store: malformed data resilience", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a corrupted L2 cache entry is treated as a miss and falls back to origin, not an error", async () => {
    const hub = fakeRedisHub();
    const raw = hub.makeClient(); // to write a corrupted entry directly, bypassing store.set's JSON.stringify
    const store = createRedisCacheStore(hub.makeClient(), undefined, { prefix: "corrupt:" });

    let reads = 0;
    const mock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ({ text: `fresh-${++reads}` }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, cacheStore: store });
    await client.connect();

    // Plant a corrupted (non-JSON) value directly under the exact key the store would use.
    const key = serializeKey({ kind: "resource", server: "s", uri: "mem://doc" });
    await raw.set(`corrupt:${key}`, "{not-valid-json");

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await client.readResource("mem://doc")) as { contents: { text: string }[] };

    // Must have fallen through to a real origin fetch instead of throwing.
    expect(res.contents[0]?.text).toBe("fresh-1");
    expect(reads).toBe(1);
    expect(errSpy).toHaveBeenCalled(); // logged, not swallowed silently

    await client.close();
  });

  it("a malformed pub/sub invalidation message does not crash the listener", async () => {
    const hub = fakeRedisHub();
    const channel = "pubsub-test:invalidate";
    const store = createRedisCacheStore(hub.makeClient(), hub.makeClient(), { prefix: "pubsub:", channel });

    const received: string[][] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.subscribeInvalidations!((tags) => received.push(tags));
    await tick(10); // let the subscribe() call register before publishing

    // Publish a non-JSON message directly on the invalidation channel — must not reject/throw.
    const publisher = hub.makeClient();
    await expect(publisher.publish(channel, "not json at all")).resolves.not.toThrow();
    await tick(10);

    // The listener survived; a subsequent well-formed message is still delivered.
    await publisher.publish(channel, JSON.stringify(["tag-a"]));
    await tick(10);

    expect(received).toEqual([["tag-a"]]);
    expect(errSpy).toHaveBeenCalled();
  });
});
