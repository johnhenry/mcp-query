import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { ensureSynced, attachMcpqSync } from "../src/bridge.js";
import { resourceQueryKey, listQueryKey } from "../src/keys.js";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("ensureSynced (live sync bridge)", () => {
  it("mirrors protocol-pushed cache writes into TanStack via setQueryData, without an extra client read", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a", read: () => ({ text: "v1" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = new QueryClient();

    const cacheKey = { kind: "resource" as const, server: "s", uri: "mem://a" };
    const queryKey = resourceQueryKey("s", "mem://a");
    ensureSynced(client, qc, cacheKey, queryKey);

    // Trigger a protocol push (resources/updated) — the client re-reads on its own,
    // landing in ITS cache; our sync listener should mirror it into TanStack.
    client.cache.write(cacheKey, { text: "v2" }, { tags: [] });
    await tick();

    expect(qc.getQueryData(queryKey as unknown[])).toEqual({ text: "v2" });
    await client.close();
  });

  it("registering the same (client, queryClient, queryKey) twice only subscribes once", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a", read: () => ({ text: "v1" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = new QueryClient();
    const cacheKey = { kind: "resource" as const, server: "s", uri: "mem://a" };
    const queryKey = resourceQueryKey("s", "mem://a");

    ensureSynced(client, qc, cacheKey, queryKey);
    const subscribersBefore = client.cache.getSnapshot(cacheKey)?.subscribers;
    ensureSynced(client, qc, cacheKey, queryKey);
    expect(client.cache.getSnapshot(cacheKey)?.subscribers).toBe(subscribersBefore);

    await client.close();
  });

  it("releases the mcp-query-side subscription when TanStack removes the query (gc)", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a", read: () => ({ text: "v1" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = new QueryClient();
    const cacheKey = { kind: "resource" as const, server: "s", uri: "mem://a" };
    const queryKey = resourceQueryKey("s", "mem://a");

    ensureSynced(client, qc, cacheKey, queryKey);
    expect(client.cache.getSnapshot(cacheKey)?.subscribers).toBeGreaterThan(0);

    qc.setQueryData(queryKey as unknown[], { text: "seed" }); // create the query entry so it's removable
    qc.getQueryCache().remove(qc.getQueryCache().find({ queryKey: queryKey as unknown[] })!);

    expect(client.cache.getSnapshot(cacheKey)?.subscribers).toBe(0);
    await client.close();
  });
});

describe("tag-wide invalidation (cache.onExternalInvalidate)", () => {
  const setup = async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a", read: () => ({ text: "v1" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = new QueryClient();
    return { client, qc };
  };

  it("invalidates TanStack queries with no live per-key subscription when a protocol push arrives", async () => {
    const { client, qc } = await setup();
    const inactiveKey = resourceQueryKey("s", "mem://a");
    qc.setQueryData(inactiveKey as unknown[], { text: "old" });
    attachMcpqSync(client, qc);

    client.cache.onResourceUpdated("s", "mem://a");

    expect(qc.getQueryState(inactiveKey as unknown[])?.isInvalidated).toBe(true);
    await client.close();
  });

  it("covers server-wide and list-changed tags, and leaves unrelated queries alone", async () => {
    const { client, qc } = await setup();
    const a = resourceQueryKey("s", "mem://a");
    const other = resourceQueryKey("other", "mem://a");
    const list = listQueryKey("s", "tools");
    for (const k of [a, other, list]) qc.setQueryData(k as unknown[], 1);
    attachMcpqSync(client, qc);

    client.cache.onListChanged("s", "tools");
    expect(qc.getQueryState(list as unknown[])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(a as unknown[])?.isInvalidated).toBe(false);

    client.cache.markStaleByServer("s");
    expect(qc.getQueryState(a as unknown[])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(other as unknown[])?.isInvalidated).toBe(false);
    await client.close();
  });

  it("does not double-invalidate a query that has a live per-key subscription", async () => {
    const { client, qc } = await setup();
    const cacheKey = { kind: "resource" as const, server: "s", uri: "mem://a" };
    const queryKey = resourceQueryKey("s", "mem://a");
    qc.setQueryData(queryKey as unknown[], 1);
    ensureSynced(client, qc, cacheKey, queryKey);

    client.cache.onResourceUpdated("s", "mem://a");

    expect(qc.getQueryState(queryKey as unknown[])?.isInvalidated).toBe(false);
    await client.close();
  });
});
