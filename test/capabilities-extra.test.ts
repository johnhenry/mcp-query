import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MCPCache } from "../src/core/cache.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { persistCache } from "../src/core/persist.js";
import { isDestructive, structuredContent, contentAnnotations } from "../src/core/annotations.js";
import { resourceTag, entityTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("ping", () => {
  it("round-trips a liveness check", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();
    await expect(client.ping("srv")).resolves.toBeDefined();
    await client.close();
  });
});

describe("completion", () => {
  it("returns argument completions", async () => {
    const mock = new MockMCPServer({
      prompts: [{ name: "greet" }],
      completions: { lang: ["en", "es", "fr"] },
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();
    const values = await client.complete({ type: "ref/prompt", name: "greet" }, { name: "lang", value: "" }, "srv");
    expect(values).toEqual(["en", "es", "fr"]);
    await client.close();
  });
});

describe("dynamic topology", () => {
  it("adds and removes a server at runtime", async () => {
    const a = new MockMCPServer({ tools: [{ name: "a_tool" }] });
    const b = new MockMCPServer({ tools: [{ name: "b_tool", handler: () => ({ content: [{ type: "text", text: "B" }] }) }] });
    const client = new MCPClient({ servers: { a: { transport: a.transport } } });
    await client.connect();
    expect(client.connections().map((c) => c.name)).toEqual(["a"]);

    await client.addServer("b", { transport: b.transport });
    expect(client.serverState("b")).toBe("ready");
    const r = (await client.callTool("b.b_tool", {})) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("B");

    await client.removeServer("b");
    expect(client.connection("b")).toBeUndefined();
    await client.close();
  });
});

describe("read retry", () => {
  it("retries a failing read up to the configured count", async () => {
    let attempts = 0;
    const mock = new MockMCPServer({
      resources: [
        {
          uri: "mem://flaky",
          read: () => {
            attempts++;
            if (attempts < 3) throw new Error("transient");
            return { text: "ok" };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, retry: 3 });
    await client.connect();
    const res = (await client.readResource("mem://flaky")) as { contents: { text: string }[] };
    expect(res.contents[0]!.text).toBe("ok");
    expect(attempts).toBe(3);
    await client.close();
  });
});

describe("persistence", () => {
  it("dehydrates and rehydrates cache entries into a fresh cache", () => {
    const a = new MCPCache();
    const key: CacheKey = { kind: "resource", server: "srv", uri: "mem://x" };
    a.write(key, { v: 1 }, { tags: [resourceTag("srv", "mem://x")] });
    const snap = a.dehydrate();

    const b = new MCPCache();
    b.hydrate(snap);
    expect(b.getSnapshot(key)?.data).toEqual({ v: 1 });
    expect(b.getSnapshot(key)?.tags.has(resourceTag("srv", "mem://x"))).toBe(true);
  });

  it("persistCache hydrates from storage on start and saves on change", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const c1 = new MCPCache();
    const stop = persistCache(c1, storage, { debounce: 1 });
    c1.write({ kind: "resource", server: "srv", uri: "mem://p" }, { saved: true });
    await tick(20);
    expect(store.has("mcp-query-cache")).toBe(true);
    stop();

    const c2 = new MCPCache();
    persistCache(c2, storage, { debounce: 1 });
    expect(c2.getSnapshot({ kind: "resource", server: "srv", uri: "mem://p" })?.data).toEqual({ saved: true });
  });
});

describe("entity-layer tagging", () => {
  it("derives tags from the result and invalidates by entity", async () => {
    const mock = new MockMCPServer({
      resources: [{ uri: "db://issues", read: () => ({ text: JSON.stringify([{ id: 7 }]) }) }],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();
    const key: CacheKey = { kind: "resource", server: "srv", uri: "db://issues" };
    await client.readResource("db://issues", { providesTags: () => [entityTag("Issue", 7)] });
    expect(client.cache.isStale(key)).toBe(false);
    client.cache.invalidateTags([entityTag("Issue", 7)]);
    expect(client.cache.isStale(key)).toBe(true);
    await client.close();
  });
});

describe("annotation helpers", () => {
  it("reads tool hints, structured content, and content annotations", () => {
    expect(isDestructive({ name: "rm", annotations: { destructiveHint: true } } as never)).toBe(true);
    expect(structuredContent({ structuredContent: { total: 5 } })).toEqual({ total: 5 });
    expect(contentAnnotations({ type: "text", text: "x", annotations: { audience: ["user"], priority: 0.9 } })).toEqual({
      audience: ["user"],
      priority: 0.9,
    });
  });
});
