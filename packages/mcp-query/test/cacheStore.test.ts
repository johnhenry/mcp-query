import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MemoryCacheStore } from "../src/core/cacheStore.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { resourceTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("L2 CacheStore (cross-instance sharing)", () => {
  it("lets node B serve a read from L2 without hitting its server", async () => {
    const store = new MemoryCacheStore();
    let readsB = 0;
    const aMock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ({ text: "from-A" }) }] });
    const bMock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ((readsB += 1), { text: "B-own" }) }] });
    const A = new MCPClient({ servers: { s: { transport: aMock.transport } }, cacheStore: store });
    const B = new MCPClient({ servers: { s: { transport: bMock.transport } }, cacheStore: store });
    await A.connect();
    await B.connect();

    const r1 = (await A.readResource("mem://doc")) as { contents: { text: string }[] };
    expect(r1.contents[0]!.text).toBe("from-A");

    // B: L1 miss -> L2 hit (A's write) -> returns A's value, never touches B's server.
    const r2 = (await B.readResource("mem://doc")) as { contents: { text: string }[] };
    expect(r2.contents[0]!.text).toBe("from-A");
    expect(readsB).toBe(0);

    await A.close();
    await B.close();
  });

  it("propagates declared invalidations across nodes (broadcast)", async () => {
    const store = new MemoryCacheStore();
    const aMock = new MockMCPServer({ tools: [{ name: "touch", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }] });
    const bMock = new MockMCPServer({ resources: [{ uri: "mem://x", read: () => ({ text: "X" }) }] });
    const A = new MCPClient({ servers: { s: { transport: aMock.transport } }, cacheStore: store });
    const B = new MCPClient({ servers: { s: { transport: bMock.transport } }, cacheStore: store });
    await A.connect();
    await B.connect();

    await B.readResource("mem://x");
    const keyB: CacheKey = { kind: "resource", server: "s", uri: "mem://x" };
    expect(B.cache.isStale(keyB)).toBe(false);

    // A's declared invalidation broadcasts via the shared store → B's L1 goes stale.
    await A.callTool("s.touch", {}, { invalidates: [resourceTag("s", "mem://x")] });
    await tick();
    expect(B.cache.isStale(keyB)).toBe(true);

    await A.close();
    await B.close();
  });
});
