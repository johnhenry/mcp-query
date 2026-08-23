import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { ensureSynced } from "../src/bridge.js";
import { resourceQueryKey } from "../src/keys.js";

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
