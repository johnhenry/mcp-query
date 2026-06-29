import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { DevtoolsHub } from "../src/devtools/protocol.js";
import type { CacheKey } from "../src/core/keys.js";

describe("roots handler", () => {
  it("answers a server's roots/list request", async () => {
    const mock = new MockMCPServer({
      tools: [
        {
          name: "where",
          handler: async (_a, ctx) => {
            const r = await ctx.listRoots();
            return { content: [{ type: "text", text: r.roots.map((x) => x.uri).join(",") }] };
          },
        },
      ],
    });
    const client = new MCPClient({
      servers: { s: { transport: mock.transport } },
      handlers: { roots: () => [{ uri: "file:///work" }, { uri: "file:///tmp" }] },
    });
    await client.connect();
    const r = (await client.callTool("s.where", {})) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("file:///work,file:///tmp");
    await client.close();
  });
});

describe("tool progress notifications", () => {
  it("delivers progress to the onProgress callback", async () => {
    const mock = new MockMCPServer({
      tools: [
        {
          name: "work",
          handler: async (_a, ctx) => {
            ctx.progress(50, 100);
            ctx.progress(100, 100);
            return { content: [{ type: "text", text: "done" }] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const onProgress = vi.fn();
    await client.callTool("s.work", {}, { onProgress });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ progress: 50, total: 100 }));
    await client.close();
  });
});

describe("optimistic rollback on a protocol error", () => {
  it("restores the cache when the call rejects (not just isError)", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "boom", handler: () => { throw new Error("kaboom"); } }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://x" };
    client.cache.write(key, { items: ["existing"] });

    await expect(
      client.callTool("s.boom", {}, {
        optimistic: () => [{ key, recipe: (p: { items: string[] }) => ({ items: [...p.items, "optimistic"] }) }],
      }),
    ).rejects.toBeTruthy();

    expect(client.cache.getSnapshot(key)?.data).toEqual({ items: ["existing"] });
    await client.close();
  });
});

describe("DevtoolsHub", () => {
  it("buffers up to capacity and fans out to subscribers with unsubscribe", () => {
    const hub = new DevtoolsHub(3);
    const fn = vi.fn();
    const unsub = hub.subscribe(fn);
    for (let i = 0; i < 5; i++) hub.emit({ type: "invalidate", keys: [String(i)] });
    expect(hub.events()).toHaveLength(3); // capped
    expect(fn).toHaveBeenCalledTimes(5);
    unsub();
    hub.emit({ type: "invalidate", keys: ["x"] });
    expect(fn).toHaveBeenCalledTimes(5); // no more after unsubscribe
  });
});
