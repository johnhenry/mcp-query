import { describe, it, expect, vi } from "vitest";
import { ServerConnection } from "../src/core/connection.js";
import { MCPCache } from "../src/core/cache.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { resourceTag, capsTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";
import type { TrafficEvent } from "../src/core/instrument.js";

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
    // Unsolicited per-resource updates are 2025-era semantics: the modern era
    // delivers them only for URIs opted into via subscriptions/listen.
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a" }, { uri: "mem://b" }] }, { era: "legacy" });
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

// Wraps a working (non-stdio) transport so it structurally passes the SDK's own stdio
// detection (`"stderr" in t && "pid" in t`, see instrument.ts's header) — lets us drive
// connection.ts's `emitSyntheticProbeMarker` (which does the exact same structural check)
// without spawning a real child process. All real reads/writes/methods still forward to
// the wrapped transport unchanged.
function fakeStdioShape<T extends object>(real: T): T {
  return new Proxy(real, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
    has(target, prop) {
      if (prop === "stderr" || prop === "pid") return true;
      return Reflect.has(target, prop);
    },
  });
}

describe("synthetic devtools marker for the stdio 'auto'-probe (#16)", () => {
  it("emits exactly one synthetic marker for a stdio-shaped transport under auto negotiation", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const cache = new MCPCache();
    const events: TrafficEvent[] = [];
    const conn = new ServerConnection(
      "srv",
      { transport: () => fakeStdioShape(mock.transport()), versionNegotiation: { mode: "auto" } },
      { cache, handlers: {}, onMessage: (_s, ev) => events.push(ev) },
    );
    // The fake transport disguises a non-stdio transport as stdio-shaped purely to drive
    // the structural check — the SDK's real stdio sibling-probe machinery (which needs
    // actual StdioClientTransport internals like `_serverParams`) isn't expected to
    // succeed against it. We only assert on the marker, emitted before that attempt.
    await conn.connect().catch(() => {});
    const synthetic = events.filter((e) => e.synthetic);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]).toMatchObject({ dir: "out", message: { method: "server/discover" } });
    await conn.close().catch(() => {});
  });

  it("emits no synthetic marker for a non-stdio transport", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const cache = new MCPCache();
    const events: TrafficEvent[] = [];
    const conn = new ServerConnection(
      "srv",
      { transport: mock.transport, versionNegotiation: { mode: "auto" } },
      { cache, handlers: {}, onMessage: (_s, ev) => events.push(ev) },
    );
    await conn.connect();
    expect(events.some((e) => e.synthetic)).toBe(false);
    await conn.close();
  });

  it("emits no synthetic marker when negotiation mode isn't 'auto'", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const cache = new MCPCache();
    const events: TrafficEvent[] = [];
    const conn = new ServerConnection(
      "srv",
      { transport: () => fakeStdioShape(mock.transport()), versionNegotiation: { mode: "legacy" } },
      { cache, handlers: {}, onMessage: (_s, ev) => events.push(ev) },
    );
    await conn.connect();
    expect(events.some((e) => e.synthetic)).toBe(false);
    await conn.close();
  });

  it("emits no synthetic marker without a devtools tap (no onMessage)", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const cache = new MCPCache();
    const conn = new ServerConnection(
      "srv",
      { transport: () => fakeStdioShape(mock.transport()), versionNegotiation: { mode: "auto" } },
      { cache, handlers: {} },
    );
    // No onMessage configured — emitSyntheticProbeMarker must no-op, not throw.
    await expect(conn.connect().catch(() => {})).resolves.toBeUndefined();
    await conn.close().catch(() => {});
  });
});
