// Session resumption (issue #8): persist the transport session id (plus what
// `initialize` negotiated) so a page reload or transport drop resumes the same
// server-side session instead of silently minting a new one.
//
// The mock here emulates Streamable HTTP session semantics over the in-memory
// MockMCPServer: a fresh connect "assigns" a session id once the initialize
// round-trip happens; a resumed connect presets `transport.sessionId` (which makes
// the SDK client skip `initialize`); a forgotten session rejects every request the
// way a stateful HTTP server 404s an unknown Mcp-Session-Id.

import { describe, it, expect } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

// ── test double: session-aware transport factory ────────────────────────────
function deadTransport(sessionId: string): Transport {
  const t: Transport = {
    sessionId,
    async start() {},
    async send() {
      throw new Error("HTTP 404: session not found");
    },
    async close() {
      t.onclose?.();
    },
  };
  return t;
}

function sessionfulMock(mock: MockMCPServer) {
  const live = new Set<string>();
  let n = 0;
  const calls: Array<string | undefined> = []; // sessionId the factory was invoked with
  const transport = (ctx?: TransportContext): Transport => {
    calls.push(ctx?.sessionId);
    if (ctx?.sessionId !== undefined) {
      if (!live.has(ctx.sessionId)) return deadTransport(ctx.sessionId);
      const t = mock.transport();
      (t as { sessionId?: string }).sessionId = ctx.sessionId; // SDK will skip initialize
      return t;
    }
    const t = mock.transport();
    const id = `sess-${++n}`;
    const send = t.send.bind(t);
    // The real transport learns its id from the initialize response header; here the
    // first outbound message is `initialize`, so stamp the id as soon as it's sent.
    t.send = async (...args: Parameters<Transport["send"]>) => {
      await send(...args);
      (t as { sessionId?: string }).sessionId = id;
      live.add(id);
    };
    return t;
  };
  return { transport, live, calls };
}

function connectionWith(
  mock: MockMCPServer,
  transport: (ctx?: TransportContext) => Transport,
  sessionStore?: SessionStore,
) {
  const cache = new MCPCache();
  const conn = new ServerConnection(
    "srv",
    { transport, sessionStore, retryDelay: () => 5 },
    { cache, handlers: {} },
  );
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
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const { transport } = sessionfulMock(mock);
    const store = memorySessionStore();
    const { conn } = connectionWith(mock, transport, store);

    await conn.connect();
    expect(conn.state).toBe("ready");
    expect(conn.resumed).toBe(false);

    const saved = await store.get();
    expect(saved?.sessionId).toBe("sess-1");
    expect(saved?.capabilities?.tools).toBeTruthy();
    expect(saved?.serverVersion).toBe("1.0.0"); // restores conn.protocolVersion on resume
    await conn.close();
  });

  it("persists nothing when the transport is sessionless (stdio/in-memory)", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const store = memorySessionStore();
    // plain mock transport: never exposes a sessionId
    const { conn } = connectionWith(mock, () => mock.transport(), store);
    await conn.connect();
    expect(await store.get()).toBeUndefined();
    expect(conn.resumed).toBe(false);
    await conn.close();
  });
});

// ── resume ───────────────────────────────────────────────────────────────────
describe("session resume", () => {
  it("resumes a stored session: factory gets the id, initialize is skipped, capabilities restore", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const { transport, calls } = sessionfulMock(mock);
    const store = memorySessionStore();

    const first = connectionWith(mock, transport, store);
    await first.conn.connect();
    await first.conn.close();

    // "Page reload": a brand-new connection sharing only the store.
    const second = connectionWith(mock, transport, store);
    await second.conn.connect();

    expect(calls.at(-1)).toBe("sess-1"); // factory received the stored id
    expect(second.conn.resumed).toBe(true);
    expect(second.conn.state).toBe("ready");
    // initialize was skipped (the server never saw clientInfo)…
    expect(mock.clientInfo()).toBeUndefined();
    // …so capabilities must have been restored from the persisted record,
    // which is what lets the catalog refresh run.
    expect(second.conn.supports("tools")).toBe(true);
    expect(second.conn.tools.has("echo")).toBe(true);
    await second.conn.close();
  });

  it("falls back to a fresh initialize when the server forgot the session", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const { transport, calls } = sessionfulMock(mock);
    const store = memorySessionStore();
    await store.set({ sessionId: "stale-id", capabilities: { tools: {} } }); // server never heard of it

    const { conn } = connectionWith(mock, transport, store);
    await conn.connect(); // must not throw: validated fallback

    expect(calls[0]).toBe("stale-id"); // tried the resume first
    expect(calls[1]).toBeUndefined(); // then fell back to a fresh connect
    expect(conn.resumed).toBe(false);
    expect(conn.state).toBe("ready");
    expect(conn.tools.has("echo")).toBe(true);
    expect((await store.get())?.sessionId).toBe("sess-1"); // stale record replaced
    await conn.close();
  });
});

// ── reconnect ────────────────────────────────────────────────────────────────
describe("session resume across reconnect", () => {
  it("a transport drop reconnects into the SAME server-side session", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const { transport, calls } = sessionfulMock(mock);
    const store = memorySessionStore();
    const { conn } = connectionWith(mock, transport, store);
    await conn.connect();
    expect(calls).toEqual([undefined]);

    await conn.sdk.transport?.close(); // mid-session drop → scheduleReconnect
    await tick(60);

    expect(conn.state).toBe("ready");
    expect(calls.at(-1)).toBe("sess-1"); // reconnect resumed, not re-initialized
    expect(conn.resumed).toBe(true);
    await conn.close();
  });

  it("without a sessionStore, reconnect keeps today's fresh-init behavior", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo" }] });
    const { transport, calls } = sessionfulMock(mock);
    const { conn } = connectionWith(mock, transport, undefined);
    await conn.connect();

    await conn.sdk.transport?.close();
    await tick(60);

    expect(conn.state).toBe("ready");
    expect(calls).toEqual([undefined, undefined]); // never asked to resume
    expect(conn.resumed).toBe(false);
    await conn.close();
  });
});
