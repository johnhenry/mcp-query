// 2026-07-28 era matrix: version negotiation, MRTR through the broker, the
// subscriptions/listen delivery path, SEP-2549 cache hints, and error mapping.
// These are the modern-era counterparts of the legacy-pinned behavioral tests.

import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { ServerConnection } from "../src/core/connection.js";
import { MCPCache } from "../src/core/cache.js";
import { MemoryCacheStore } from "../src/core/cacheStore.js";
import { InteractionBroker } from "../src/core/interactions.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { resourceTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";
import type { MCPError } from "../src/core/types.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Wait for the next pending interaction, then settle it. */
async function settleNext(broker: InteractionBroker, decision: Parameters<InteractionBroker["resolve"]>[1]) {
  for (let i = 0; i < 200; i++) {
    const [next] = broker.list();
    if (next) {
      broker.resolve(next.id, decision);
      return next;
    }
    await tick(5);
  }
  throw new Error("no interaction appeared");
}

describe("version negotiation matrix", () => {
  it("'auto' against a dual-era server negotiates modern", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const conn = new ServerConnection("s", { transport: mock.transport }, { cache: new MCPCache(), handlers: {} });
    await conn.connect();
    expect(conn.era).toBe("modern");
    await conn.close();
    await mock.close();
  });

  it("'auto' against a legacy-only server falls back to the 2025 handshake", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "legacy" });
    const conn = new ServerConnection("s", { transport: mock.transport }, { cache: new MCPCache(), handlers: {} });
    await conn.connect();
    expect(conn.era).toBe("legacy");
    expect(conn.tools.has("t")).toBe(true);
    await conn.close();
    await mock.close();
  });

  it("'legacy' mode skips the probe entirely", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const conn = new ServerConnection(
      "s",
      { transport: mock.transport, versionNegotiation: { mode: "legacy" } },
      { cache: new MCPCache(), handlers: {} },
    );
    await conn.connect();
    expect(conn.era).toBe("legacy");
    await conn.close();
    await mock.close();
  });

  it("a pin rejects against a legacy-only server", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "legacy" });
    const conn = new ServerConnection(
      "s",
      { transport: mock.transport, versionNegotiation: { mode: { pin: "2026-07-28" } }, maxRetries: 0 },
      { cache: new MCPCache(), handlers: {} },
    );
    await expect(conn.connect()).rejects.toBeTruthy();
    await conn.close();
    await mock.close();
  });

  it("a modern-only server rejects a legacy-pinned client", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "modern" });
    const conn = new ServerConnection(
      "s",
      { transport: mock.transport, versionNegotiation: { mode: "legacy" }, maxRetries: 0 },
      { cache: new MCPCache(), handlers: {} },
    );
    await expect(conn.connect()).rejects.toBeTruthy();
    await conn.close();
    await mock.close();
  });
});

describe("MRTR through the broker (modern era)", () => {
  it("fulfils an embedded form elicitation via the same broker queue and retries to completion", async () => {
    const broker = new InteractionBroker();
    const mock = new MockMCPServer(
      {
        tools: [
          {
            name: "ask_name",
            handler: async (_args, ctx) => {
              const r = await ctx.elicit({
                message: "your name?",
                requestedSchema: { type: "object", properties: { name: { type: "string" } } },
              });
              return { content: [{ type: "text", text: `hi ${(r.content as { name?: string })?.name ?? "?"}` }] };
            },
          },
        ],
      },
      { era: "modern" },
    );
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();
    expect(client.connections()[0]!.era).toBe("modern");

    const call = client.callTool("srv.ask_name", {}) as Promise<{ content: { text: string }[] }>;
    const pending = await settleNext(broker, { action: "approve", content: { name: "Grace" } });
    expect(pending.type).toBe("elicitation");
    const res = await call;
    expect(res.content[0]!.text).toBe("hi Grace");
    await client.close();
    await mock.close();
  });

  it("policy deny inside a round declines the elicitation (server sees decline)", async () => {
    const broker = new InteractionBroker({ policy: () => "deny" });
    const mock = new MockMCPServer(
      {
        tools: [
          {
            name: "ask",
            handler: async (_args, ctx) => {
              const r = await ctx.elicit({ message: "?", requestedSchema: { type: "object", properties: {} } });
              return { content: [{ type: "text", text: r.action }] };
            },
          },
        ],
      },
      { era: "modern" },
    );
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();
    const res = (await client.callTool("srv.ask", {})) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("decline");
    expect(broker.auditLog().at(-1)?.outcome).toBe("auto-deny");
    await client.close();
    await mock.close();
  });

  it("url-mode elicitation rides MRTR (no elicitationId anywhere)", async () => {
    const broker = new InteractionBroker();
    const mock = new MockMCPServer(
      {
        tools: [
          {
            name: "sign_in",
            handler: async (_args, ctx) => {
              const r = await ctx.elicit({ mode: "url", message: "finish sign-in", url: "https://example.com/auth" });
              return { content: [{ type: "text", text: r.action }] };
            },
          },
        ],
      },
      { era: "modern" },
    );
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();

    const call = client.callTool("srv.sign_in", {}) as Promise<{ content: { text: string }[] }>;
    const pending = await settleNext(broker, { action: "approve" });
    const payload = pending.payload as Record<string, unknown>;
    expect(payload.mode).toBe("url");
    expect(payload.url).toBe("https://example.com/auth");
    expect(payload).not.toHaveProperty("elicitationId"); // removed by the final spec
    expect((await call).content[0]!.text).toBe("accept");
    await client.close();
    await mock.close();
  });

  it("embedded sampling routes through the broker's model", async () => {
    const broker = new InteractionBroker({
      policy: () => "allow",
      model: async () => ({
        role: "assistant" as const,
        content: { type: "text" as const, text: "MODELED" },
        model: "fake",
        stopReason: "endTurn",
      }),
    });
    const mock = new MockMCPServer(
      {
        tools: [
          {
            name: "summarize",
            handler: async (_args, ctx) => {
              const r = await ctx.sample({ messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 });
              return { content: [{ type: "text", text: (r.content as { text?: string }).text ?? "" }] };
            },
          },
        ],
      },
      { era: "modern" },
    );
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, interactions: broker });
    await client.connect();
    const res = (await client.callTool("srv.summarize", {})) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("MODELED");
    await client.close();
    await mock.close();
  });
});

describe("subscriptions/listen (modern era)", () => {
  it("delivers resources/updated only for subscribed URIs and invalidates the cache", async () => {
    const mock = new MockMCPServer({
      resources: [
        { uri: "mem://a", read: () => ({ text: "A" }) },
        { uri: "mem://b", read: () => ({ text: "B" }) },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    expect(client.connections()[0]!.era).toBe("modern");

    // Subscribe to mem://a only (ref-counted through the cache observer path).
    await client.readResource("mem://a", { subscribe: true });
    await client.readResource("mem://b");
    await tick(100); // listen re-open (debounced) + ack

    await mock.notifyResourceUpdated("mem://a");
    await mock.notifyResourceUpdated("mem://b");
    await tick(50);

    const ka: CacheKey = { kind: "resource", server: "s", uri: "mem://a" };
    const kb: CacheKey = { kind: "resource", server: "s", uri: "mem://b" };
    expect(client.cache.getSnapshot(ka)?.isStale).toBe(true); // subscribed → delivered
    expect(client.cache.getSnapshot(kb)?.isStale).toBe(false); // unsubscribed → filtered out
    await client.close();
    await mock.close();
  });

  it("tools list_changed arrives on the listen stream and re-lists", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "a" }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    expect(client.listTools("s").map((t) => t.name)).toEqual(["a"]);

    mock.spec.tools = [{ name: "a" }, { name: "b" }];
    await mock.notifyToolListChanged();
    await tick(100);
    expect(client.listTools("s").map((t) => t.name).sort()).toEqual(["a", "b"]);
    await client.close();
    await mock.close();
  });
});

describe("SEP-2549 cache hints", () => {
  it("modern-era results are cacheScope-private by default → L2 write-through is skipped", async () => {
    const store = new MemoryCacheStore();
    const aMock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ({ text: "from-A" }) }] });
    let readsB = 0;
    const bMock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ((readsB += 1), { text: "B-own" }) }] });
    const A = new MCPClient({ servers: { s: { transport: aMock.transport } }, cacheStore: store });
    const B = new MCPClient({ servers: { s: { transport: bMock.transport } }, cacheStore: store });
    await A.connect();
    await B.connect();

    await A.readResource("mem://doc"); // private-scoped, unpartitioned → NOT shared
    const r2 = (await B.readResource("mem://doc")) as { contents: { text: string }[] };
    expect(r2.contents[0]!.text).toBe("B-own"); // L2 miss → B's own server
    expect(readsB).toBe(1);
    await A.close();
    await B.close();
    await aMock.close();
    await bMock.close();
  });

  it("a partitioned private entry IS shared through L2 (partition = auth context)", async () => {
    const store = new MemoryCacheStore();
    const aMock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ({ text: "from-A" }) }] });
    let readsB = 0;
    const bMock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ((readsB += 1), { text: "B-own" }) }] });
    const A = new MCPClient({ servers: { s: { transport: aMock.transport } }, cacheStore: store });
    const B = new MCPClient({ servers: { s: { transport: bMock.transport } }, cacheStore: store });
    await A.connect();
    await B.connect();

    const context = { partition: "tenant-1" };
    await A.readResource("mem://doc", { context });
    const r2 = (await B.readResource("mem://doc", { context })) as { contents: { text: string }[] };
    expect(r2.contents[0]!.text).toBe("from-A"); // same partition → L2 hit
    expect(readsB).toBe(0);
    await A.close();
    await B.close();
    await aMock.close();
    await bMock.close();
  });

  it("caller staleTime beats server hints; ttlMs<=0 falls back to the default", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://x", read: () => ({ text: "x" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();

    // The v2 server stamps ttlMs: 0 by default — treated as "no signal", so the
    // entry stays fresh under mcp-query's default staleTime.
    await client.readResource("mem://x");
    const key: CacheKey = { kind: "resource", server: "s", uri: "mem://x" };
    expect(client.cache.isStale(key)).toBe(false);

    // Explicit caller staleTime: 0 = immediately stale, regardless of hints.
    await client.readResource("mem://x", { staleTime: 0 });
    await tick(5); // staleness is strictly time-elapsed > staleTime
    expect(client.cache.isStale(key)).toBe(true);
    await client.close();
    await mock.close();
  });
});

describe("error mapping", () => {
  it("maps -32602 resource-not-found into the cache error with the uri", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://exists" }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const raw = (await client.readResource("mem://missing", { server: "s" }).catch((e: unknown) => e)) as {
      code?: number;
    };
    expect(raw.code).toBe(-32602); // the 2026-07-28 code (was -32002 pre-revision)
    // The cache entry carries the classified MCPError, including the uri.
    const entry = client.cache.getSnapshot({ kind: "resource", server: "s", uri: "mem://missing" });
    const err = entry?.error as MCPError | undefined;
    expect(err?.kind).toBe("protocol");
    expect(err?.code).toBe(-32602);
    expect(err?.uri).toBe("mem://missing");
    await client.close();
    await mock.close();
  });

  it("classifies an absent resultType as complete (legacy interop)", async () => {
    // A legacy-era call's result has no resultType; the client returns it plainly.
    const mock = new MockMCPServer(
      { tools: [{ name: "t", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }] },
      { era: "legacy" },
    );
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const res = (await client.callTool("s.t", {})) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("ok");
    await client.close();
    await mock.close();
  });
});
