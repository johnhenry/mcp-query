// @vitest-environment happy-dom
// Switchboard integration: an in-process @mcp-query/gate (over a linked in-memory
// transport pair) fronting a MockMCPServer upstream, consumed by a real MCPClient with
// the app's interceptor chain — governance, tracing, and tenant partitions end-to-end.

import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MCPClient } from "mcp-query";
import { rateLimit } from "mcp-query/server";
import { MockMCPServer } from "mcp-query/testing";
import { createGate } from "../../../packages/mcp-gate/src/index.js";
import { traceBus, traceInterceptor, tenantMetaInterceptor, activeTenant } from "../src/trace.js";

function upstream() {
  return new MockMCPServer({
    tools: [
      {
        name: "get-secret",
        annotations: { readOnlyHint: true },
        handler: () => ({ content: [{ type: "text", text: "the key is sk-EXAMPLE1234567890" }] }),
      },
      { name: "get-env", handler: () => ({ content: [{ type: "text", text: "PATH=/usr/bin" }] }) },
      { name: "wipe-db", annotations: { destructiveHint: true }, handler: () => ({ content: [] }) },
      {
        name: "whoami",
        annotations: { readOnlyHint: true },
        handler: (_a, ctx) => ({ content: [{ type: "text", text: String(ctx.meta?.tenant ?? "anon") }] }),
      },
    ],
  });
}

async function gateClient() {
  const mock = upstream();
  const gate = await createGate({
    upstreams: { everything: { transport: mock.transport } },
    policy: { deny: ["everything.get-env"], denyDestructive: true },
    redact: [{ pattern: /sk-[A-Za-z0-9]{8,}/g, replacement: "sk-[REDACTED]" }],
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gate.server.connect(serverT);
  const client = new MCPClient({
    servers: { gate: { transport: () => clientT } },
    interceptors: [traceInterceptor(), tenantMetaInterceptor(), rateLimit({ concurrency: 4 })],
  });
  await client.connect();
  return { client, gate, mock };
}

describe("gate governance through the app's client", () => {
  it("hides denied tools from discovery and denies destructive/denied calls", async () => {
    const { client } = await gateClient();
    const names = client.listTools("gate").map((t) => t.name);
    expect(names).toContain("everything.get-secret");
    expect(names).not.toContain("everything.get-env"); // list-filtered by policy

    // get-env is list-filtered → it's not even routable from the client (correct).
    await expect(client.callTool("everything.get-env", {}, { server: "gate" })).rejects.toMatchObject({
      message: expect.stringContaining("No connected server offers"),
    });
    // wipe-db is visible (the list filter can't see annotations) but denied at call time.
    await expect(client.callTool("everything.wipe-db", {}, { server: "gate" })).rejects.toMatchObject({
      message: expect.stringContaining("denied"),
    });
    await client.close();
  });

  it("redacts secrets from results", async () => {
    const { client } = await gateClient();
    const out = (await client.callTool("everything.get-secret", {}, { server: "gate" })) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]?.text).toBe("the key is sk-[REDACTED]");
    await client.close();
  });
});

describe("interceptor chain + tenant partitions", () => {
  it("stamps the active tenant, records traces, and isolates partitions", async () => {
    const { client } = await gateClient();
    const before = traceBus.rows.length;

    activeTenant.id = "acme";
    const acme = client.scope({ partition: "acme", meta: { tenant: "acme" } });
    const globex = client.scope({ partition: "globex", meta: { tenant: "globex" } });

    const a = (await acme.queryTool("everything.whoami", {}, { server: "gate" })) as { content: Array<{ text: string }> };
    const g = (await globex.queryTool("everything.whoami", {}, { server: "gate" })) as { content: Array<{ text: string }> };
    expect(a.content[0]?.text).toBe("acme");
    expect(g.content[0]?.text).toBe("globex"); // partitioned: no cross-tenant cache hit

    const traced = traceBus.rows.slice(0, traceBus.rows.length - before);
    expect(traced.some((r) => r.tenant === "acme" && r.outcome === "ok")).toBe(true);
    expect(traced.some((r) => r.tenant === "globex" && r.outcome === "ok")).toBe(true);

    const partitions = new Set(
      client.cache.dehydrate().entries.map((e) => (e.cacheKey as { partition?: string }).partition),
    );
    expect(partitions.has("acme")).toBe(true);
    expect(partitions.has("globex")).toBe(true);

    await client.close();
  });

  it("records failed outcomes in the trace", async () => {
    const { client } = await gateClient();
    await client.callTool("everything.wipe-db", {}, { server: "gate" }).catch(() => {});
    expect(traceBus.rows[0]?.target).toBe("everything.wipe-db");
    expect(traceBus.rows[0]?.outcome).not.toBe("ok");
    expect(traceBus.rows[0]?.error).toContain("denied");
    await client.close();
  });
});
