// Multi-tenant partition isolation: 50 scoped views over one client, interleaved reads
// and queries. No tenant may ever observe another tenant's data (the leak assertion),
// partitioned keys must stay distinct, and tag invalidation must fan out across ALL
// partitions (refetch is per-partition, not a leak — see docs/api.md multi-tenant notes).
import { describe, it, expect } from "vitest";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { resourceTag } from "../../src/core/tags.js";

const TENANTS = 50;
const ROUNDS = 10;

describe("partition isolation", () => {
  it("50 scoped views never observe another tenant's data", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "whoami",
          annotations: { readOnlyHint: true },
          // Echo the caller's _meta back — any cross-partition cache hit would surface
          // as tenant A receiving tenant B's id.
          handler: (_args, ctx) => ({
            content: [{ type: "text", text: String(ctx.meta?.tenant ?? "anonymous") }],
          }),
        },
      ],
      resources: [{ uri: "mem://profile", read: () => ({ text: "shared-profile" }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const scopes = Array.from({ length: TENANTS }, (_, t) =>
      client.scope({ partition: `tenant-${t}`, meta: { tenant: `tenant-${t}` } }),
    );

    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.all(
        scopes.map(async (scope, t) => {
          const r = (await scope.queryTool("whoami", { round })) as { content: Array<{ text: string }> };
          await scope.readResource("mem://profile");
          return { t, seen: r.content[0]?.text };
        }),
      );
      for (const { t, seen } of results) {
        expect(seen, `tenant-${t} observed "${seen}"`).toBe(`tenant-${t}`);
      }
    }

    // Every tenant's query is a distinct cache entry (same args, different partition).
    const keys = client.cache.dehydrate().entries.map((e) => e.cacheKey);
    const partitioned = keys.filter((k) => "partition" in k && k.partition);
    const partitions = new Set(partitioned.map((k) => (k as { partition?: string }).partition));
    expect(partitions.size).toBe(TENANTS);

    await client.close();
  });

  it("tag invalidation fans out across all partitions", async () => {
    let readCount = 0;
    const server = new MockMCPServer({
      resources: [
        {
          uri: "mem://doc",
          read: () => {
            readCount++;
            return { text: `read-${readCount}` };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const a = client.scope({ partition: "a" });
    const b = client.scope({ partition: "b" });
    await a.readResource("mem://doc");
    await b.readResource("mem://doc");
    expect(readCount).toBe(2); // partitioned: no cross-tenant cache hit

    client.cache.invalidateTags([resourceTag("s", "mem://doc")]);
    // Fresh reads in both partitions must hit the server again (stale in BOTH).
    await a.readResource("mem://doc");
    await b.readResource("mem://doc");
    expect(readCount).toBe(4);

    await client.close();
  });
});
