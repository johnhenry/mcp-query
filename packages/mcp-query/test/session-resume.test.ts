// Session resumption (issue #8): persist the transport session id (plus what
// `initialize` negotiated) so a page reload or transport drop resumes the same
// server-side session instead of silently minting a new one.
//
// 2026-07-28 note: sessions were REMOVED from the modern revision (SEP-2567) —
// this entire feature is 2025-era, so the mocks here pin `era: "legacy"` and
// drive the mock's REAL sessionful Streamable HTTP leg (genuine Mcp-Session-Id
// assignment on initialize, 404 on unknown ids). One test asserts the modern-era
// posture: no session ever exists, so a configured store never writes.

import { describe, it, expect } from "vitest";
import { ServerConnection } from "../src/core/connection.js";
import type { TransportContext } from "../src/core/connection.js";
import { MCPCache } from "../src/core/cache.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import {
  memorySessionStore,
  webStorageSessionStore,
  type SessionStore,
} from "../src/core/sessionStore.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Track what session id (if any) each transport-factory call received. */
function tracked(mock: MockMCPServer) {
  const calls: Array<string | undefined> = [];
  const transport = (ctx?: TransportContext) => {
    calls.push(ctx?.sessionId);
    return mock.transport(ctx);
  };
  return { transport, calls };
}

function connectionWith(
  transport: (ctx?: TransportContext) => ReturnType<MockMCPServer["transport"]>,
  sessionStore?: SessionStore,
) {
  const cache = new MCPCache();
  const conn = new ServerConnection("srv", { transport, sessionStore, retryDelay: () => 5 }, { cache, handlers: {} });
  return { cache, conn };
}

// ── the stores themselves ────────────────────────────────────────────────────
describe("session stores", () => {
  it("memorySessionStore round-trips and clears", async () => {
    const store = memorySessionStore();
    expect(await store.get()).toBeUndefined();
    await store.set({ sessionId: "abc", capabilities: { tools: {} }, protocolVersion: "2025-06-18" });
    expect(await store.get()).toEqual({
      sessionId: "abc",
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
    });
    await store.clear();
    expect(await store.get()).toBeUndefined();
  });

  it("webStorageSessionStore JSON round-trips against a Storage-like backend", async () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    const store = webStorageSessionStore("mcpq:srv", storage);
    expect(await store.get()).toBeUndefined();
    await store.set({ sessionId: "abc" });
    expect(backing.get("mcpq:srv")).toBeTruthy();
    expect((await store.get())?.sessionId).toBe("abc");
    await store.clear();
    expect(backing.has("mcpq:srv")).toBe(false);
  });

  it("webStorageSessionStore treats corrupt JSON as absent", async () => {
    const backing = new Map<string, string>([["k", "{not json"]]);
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    const store = webStorageSessionStore("k", storage);
    expect(await store.get()).toBeUndefined();
  });
});

// ── capture ──────────────────────────────────────────────────────────────────
describe("session capture", () => {
  it("persists sessionId + negotiated state after a fresh connect", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] }, { era: "legacy" });
    const { transport } = tracked(mock);
    const store = memorySessionStore();
    const { conn } = connectionWith(transport, store);

    await conn.connect();
    expect(conn.state).toBe("ready");
    expect(conn.resumed).toBe(false);

    const saved = await store.get();
    expect(saved?.sessionId).toMatch(/^mock-session-/); // real header-assigned id
    expect(saved?.capabilities?.tools).toBeTruthy();
    expect(saved?.serverVersion).toBe("1.0.0"); // restores conn.protocolVersion on resume
    await conn.close();
    await mock.close();
  });

  it("persists nothing on a modern-era connection (sessions removed by SEP-2567)", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] }, { era: "modern" });
    const store = memorySessionStore();
    const cache = new MCPCache();
    const conn = new ServerConnection(
      "srv",
      { transport: (ctx) => mock.transport(ctx), sessionStore: store, versions: ["2026-07-28"], retryDelay: () => 5 },
      { cache, handlers: {} },
    );
    await conn.connect();
    expect(conn.era).toBe("modern");
    expect(await store.get()).toBeUndefined();
    expect(conn.resumed).toBe(false);
    await conn.close();
    await mock.close();
  });
});

// ── resume ───────────────────────────────────────────────────────────────────
describe("session resume", () => {
  it("resumes a stored session: factory gets the id, initialize is skipped, capabilities restore", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] }, { era: "legacy" });
    const { transport, calls } = tracked(mock);
    const store = memorySessionStore();

    const first = connectionWith(transport, store);
    await first.conn.connect();
    await first.conn.close();
    const saved = (await store.get())!.sessionId;

    // "Page reload": a brand-new connection sharing only the store.
    const second = connectionWith(transport, store);
    await second.conn.connect();

    expect(calls.at(-1)).toBe(saved); // factory received the stored id
    expect(second.conn.resumed).toBe(true);
    expect(second.conn.state).toBe("ready");
    // initialize was skipped, so capabilities came from the persisted record —
    // which is what lets the catalog refresh run.
    expect(second.conn.supports("tools")).toBe(true);
    expect(second.conn.tools.has("echo")).toBe(true);
    await second.conn.close();
    await mock.close();
  });

  it("falls back to a fresh initialize when the server forgot the session", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] }, { era: "legacy" });
    const { transport, calls } = tracked(mock);
    const store = memorySessionStore();
    await store.set({ sessionId: "stale-id", capabilities: { tools: {} } }); // server never heard of it

    const { conn } = connectionWith(transport, store);
    await conn.connect(); // must not throw: validated fallback

    expect(calls[0]).toBe("stale-id"); // tried the resume first
    expect(calls[1]).toBeUndefined(); // then fell back to a fresh connect
    expect(conn.resumed).toBe(false);
    expect(conn.state).toBe("ready");
    expect(conn.tools.has("echo")).toBe(true);
    const replaced = (await store.get())?.sessionId;
    expect(replaced).toMatch(/^mock-session-/); // stale record replaced
    await conn.close();
    await mock.close();
  });
});

// ── reconnect ────────────────────────────────────────────────────────────────
describe("session resume across reconnect", () => {
  it("a transport drop reconnects into the SAME server-side session", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] }, { era: "legacy" });
    const { transport, calls } = tracked(mock);
    const store = memorySessionStore();
    const { conn } = connectionWith(transport, store);
    await conn.connect();
    expect(calls).toEqual([undefined]);
    const saved = (await store.get())!.sessionId;

    await conn.sdk.transport?.close(); // mid-session drop → scheduleReconnect
    await tick(80);

    expect(conn.state).toBe("ready");
    expect(calls.at(-1)).toBe(saved); // reconnect resumed, not re-initialized
    expect(conn.resumed).toBe(true);
    await conn.close();
    await mock.close();
  });

  it("without a sessionStore, reconnect keeps today's fresh-init behavior", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] }, { era: "legacy" });
    const { transport, calls } = tracked(mock);
    const { conn } = connectionWith(transport, undefined);
    await conn.connect();

    await conn.sdk.transport?.close();
    await tick(80);

    expect(conn.state).toBe("ready");
    expect(calls).toEqual([undefined, undefined]); // never asked to resume
    expect(conn.resumed).toBe(false);
    await conn.close();
    await mock.close();
  });
});
