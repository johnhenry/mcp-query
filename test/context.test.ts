import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { serializeKey, argsHash } from "../src/core/keys.js";
import type { CacheKey } from "../src/core/keys.js";

describe("cache key partitioning", () => {
  it("serializes identically when no partition (backward compatible)", () => {
    expect(serializeKey({ kind: "resource", server: "s", uri: "mem://a" })).toBe("resource s mem://a");
  });
  it("namespaces the key when a partition is present", () => {
    expect(serializeKey({ kind: "resource", server: "s", uri: "mem://a", partition: "t1" })).toBe("@t1 resource s mem://a");
  });
});

describe("per-tenant cache isolation (partition)", () => {
  it("keeps two tenants' reads of the same URI in separate cache entries", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://doc", read: () => ({ text: "shared" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();

    await client.readResource("mem://doc", { context: { partition: "tenantA" } });
    await client.readResource("mem://doc", { context: { partition: "tenantB" } });

    const a: CacheKey = { kind: "resource", server: "s", uri: "mem://doc", partition: "tenantA" };
    const b: CacheKey = { kind: "resource", server: "s", uri: "mem://doc", partition: "tenantB" };
    const unpartitioned: CacheKey = { kind: "resource", server: "s", uri: "mem://doc" };

    expect(client.cache.getSnapshot(a)?.status).toBe("success");
    expect(client.cache.getSnapshot(b)?.status).toBe("success");
    // the shared (no-partition) entry was never created — no cross-tenant leak
    expect(client.cache.getSnapshot(unpartitioned)).toBeUndefined();
    await client.close();
  });

  it("queryTool caches per partition", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "search", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "x" }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    await client.queryTool("s.search", { q: "y" }, { context: { partition: "t1" } });
    const k: CacheKey = { kind: "toolResult", server: "s", tool: "search", argsHash: argsHash({ q: "y" }), partition: "t1" };
    expect(client.cache.getSnapshot(k)?.status).toBe("success");
    await client.close();
  });
});

describe("per-call context meta (_meta propagation)", () => {
  it("passes context.meta to the server as request _meta", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "whoami", handler: (_a, ctx) => ({ content: [{ type: "text", text: JSON.stringify(ctx.meta ?? null) }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const r = (await client.callTool("s.whoami", {}, { context: { meta: { userId: "u-42" } } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ userId: "u-42" });
    await client.close();
  });
});

describe("client.scope()", () => {
  it("binds a context applied to every call, partitioning + propagating meta", async () => {
    const mock = new MockMCPServer({
      resources: [{ uri: "mem://x", read: () => ({ text: "ok" }) }],
      tools: [{ name: "echo", handler: (_a, ctx) => ({ content: [{ type: "text", text: String((ctx.meta as { who?: string })?.who) }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();

    const tenant = client.scope({ partition: "acme", meta: { who: "ada" } });
    await tenant.readResource("mem://x");
    const r = (await tenant.callTool("s.echo", {})) as { content: { text: string }[] };

    expect(r.content[0]!.text).toBe("ada");
    expect(client.cache.getSnapshot({ kind: "resource", server: "s", uri: "mem://x", partition: "acme" })?.status).toBe("success");
    await client.close();
  });
});
