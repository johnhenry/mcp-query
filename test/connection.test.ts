import { describe, it, expect, vi } from "vitest";
import { ServerConnection } from "../src/core/connection.js";
import { MCPCache } from "../src/core/cache.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { resourceTag, capsTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function setup(mock: MockMCPServer, onCaps?: (s: string, k: string) => void) {
  const cache = new MCPCache();
  const conn = new ServerConnection(
    "srv",
    { transport: mock.transport, retryDelay: () => 5 },
    { cache, handlers: {}, onCapabilitiesChanged: onCaps },
  );
  return { cache, conn };
}

describe("connection lifecycle", () => {
  it("connects, negotiates capabilities, and lists tools/resources/prompts", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "echo", annotations: { readOnlyHint: true } }],
      resources: [{ uri: "mem://a" }],
      prompts: [{ name: "greet" }],
    });
    const { conn } = setup(mock);
    await conn.connect();

    expect(conn.state).toBe("ready");
    expect(conn.tools.has("echo")).toBe(true);
    expect(conn.resources.has("mem://a")).toBe(true);
    expect(conn.prompts.has("greet")).toBe(true);
    expect(conn.supports("resources.subscribe")).toBe(true);
    await conn.close();
  });

  it("drains cursor-paginated tool lists", async () => {
    const tools = Array.from({ length: 25 }, (_, i) => ({ name: `t${i}` }));
    const mock = new MockMCPServer({ tools, pageSize: 10 });
    const { conn } = setup(mock);
    await conn.connect();
    expect(conn.tools.size).toBe(25);
    await conn.close();
  });
});

describe("protocol-driven invalidation", () => {
  it("resources/updated marks exactly that resource stale", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a" }, { uri: "mem://b" }] });
    const { cache, conn } = setup(mock);
    await conn.connect();

    const ka: CacheKey = { kind: "resource", server: "srv", uri: "mem://a" };
    const kb: CacheKey = { kind: "resource", server: "srv", uri: "mem://b" };
    cache.write(ka, 1, { tags: [resourceTag("srv", "mem://a")] });
    cache.write(kb, 1, { tags: [resourceTag("srv", "mem://b")] });

    await mock.notifyResourceUpdated("mem://a");
    await tick();

    expect(cache.getSnapshot(ka)?.isStale).toBe(true);
    expect(cache.getSnapshot(kb)?.isStale).toBe(false);
    await conn.close();
  });
});

describe("dynamic registration (list_changed)", () => {
  it("re-lists tools and invalidates the catalog when the server announces a change", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "a" }] });
    const onCaps = vi.fn();
    const { cache, conn } = setup(mock, onCaps);
    await conn.connect();
    expect(conn.tools.size).toBe(1);

    const capKey: CacheKey = { kind: "toolList", server: "srv" };

    // Server gains a tool, then announces the change.
    mock.spec.tools = [{ name: "a" }, { name: "b" }];
    await mock.notifyToolListChanged();
    await tick();

    expect(conn.tools.has("b")).toBe(true);
    // The catalog was re-listed into the cache (tagged), so observers see the update.
    expect((cache.getSnapshot(capKey)?.data as unknown[]).length).toBe(2);
    expect(cache.getSnapshot(capKey)?.tags.has(capsTag("srv", "tools"))).toBe(true);
    expect(onCaps).toHaveBeenCalledWith("srv", "tools");
    await conn.close();
  });
});

describe("reconnect with capability re-negotiation", () => {
  it("recovers from a mid-session drop and reconciles a changed capability set", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "a" }],
      resources: [{ uri: "mem://a" }],
    });
    const { conn } = setup(mock);
    await conn.connect();
    expect(conn.supports("resources.subscribe")).toBe(true);
    expect(mock.connectCount).toBe(1);

    // Simulate the server losing the subscribe capability on the next connect.
    mock.spec.capabilities = { tools: { listChanged: true } };
    mock.spec.resources = undefined;

    // Drop the transport mid-session -> onclose -> scheduleReconnect.
    await conn.sdk.transport?.close();
    await tick(60);

    expect(mock.connectCount).toBe(2);
    expect(conn.state).toBe("ready");
    expect(conn.supports("resources.subscribe")).toBe(false);
    await conn.close();
  });
});
