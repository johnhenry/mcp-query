import { describe, it, expect } from "vitest";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";

import { serverKey, readFrame, writeFrame, type DaemonRequest, type DaemonResponse } from "../src/daemon/protocol.js";
import { createHandler } from "../src/daemon/server.js";
import type { ConnectOptions } from "../../mcp-contract/src/index.js";

// ── (a) serverKey stability ──────────────────────────────────────────────────────

describe("(a) serverKey", () => {
  it("is stable for identical opts and distinguishes url vs stdio", () => {
    const stdio: ConnectOptions = { command: "npx", args: "-y server" };
    expect(serverKey(stdio)).toBe(serverKey({ command: "npx", args: "-y server" }));
    expect(serverKey(stdio)).toBe("stdio:npx -y server");

    const url: ConnectOptions = { url: "https://mcp.example/sse" };
    expect(serverKey(url)).toBe("https://mcp.example/sse");
    expect(serverKey(url)).not.toBe(serverKey(stdio));

    // different command → different key
    expect(serverKey({ command: "node", args: "x" })).not.toBe(serverKey({ command: "node", args: "y" }));
  });
});

// ── (b) frame read/write round-trip over a real socket pair ───────────────────────

describe("(b) frame protocol round-trip", () => {
  it("writes one frame and reads it back over a net socket pair", async () => {
    const server = net.createServer((conn) => {
      void readFrame<DaemonRequest>(conn).then((req) => {
        void writeFrame(conn, { ok: true, result: { echoed: req.op } } satisfies DaemonResponse);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const client = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    await writeFrame(client, { op: "ping", opts: { command: "x" } } satisfies DaemonRequest);
    const res = await readFrame<DaemonResponse>(client);
    expect(res).toEqual({ ok: true, result: { echoed: "ping" } });

    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// ── (c) handler logic: results + upstream reuse + reconnect-on-drop ───────────────

const everythingMock = (): MockMCPServer =>
  new MockMCPServer({
    tools: [
      {
        name: "echo",
        description: "Echo a message",
        inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        handler: (args) => ({ content: [{ type: "text", text: String(args.message) }] }),
      },
      {
        name: "add",
        description: "Add",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        handler: (args) => ({ content: [{ type: "text", text: String((args.a as number) + (args.b as number)) }] }),
      },
    ],
  });

/** A connect factory that links a Client to the given mock; counts how often it's invoked. */
function mockConnect(mock: MockMCPServer) {
  let connects = 0;
  const factory = async (_opts: ConnectOptions) => {
    connects++;
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(mock.transport());
    return { client, close: () => client.close().catch(() => {}) };
  };
  return { factory, get connects() { return connects; } };
}

describe("(c) handler", () => {
  it("tools + call return the right results", async () => {
    const mock = everythingMock();
    const { factory } = mockConnect(mock);
    const handler = createHandler(factory);
    const opts: ConnectOptions = { command: "everything" };

    const tools = await handler.handle({ op: "tools", opts });
    expect(tools.ok).toBe(true);
    if (tools.ok) {
      const names = (tools.result as Array<{ name: string }>).map((t) => t.name).sort();
      expect(names).toEqual(["add", "echo"]);
    }

    const call = await handler.handle({ op: "call", opts, tool: "echo", args: { message: "hi" } });
    expect(call.ok).toBe(true);
    if (call.ok) {
      const r = call.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toBe("hi");
    }

    await handler.closeAll();
  });

  it("coerces flag-style string args by the tool inputSchema", async () => {
    const mock = everythingMock();
    const { factory } = mockConnect(mock);
    const handler = createHandler(factory);
    const opts: ConnectOptions = { command: "everything" };

    // strings "2"/"3" must be coerced to numbers by add's inputSchema → "5"
    const call = await handler.handle({ op: "call", opts, tool: "add", args: { a: "2", b: "3" } });
    expect(call.ok).toBe(true);
    if (call.ok) {
      const r = call.result as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toBe("5");
    }
    await handler.closeAll();
  });

  it("REUSES the cached upstream across repeated calls (connects once)", async () => {
    const mock = everythingMock();
    const conn = mockConnect(mock);
    const handler = createHandler(conn.factory);
    const opts: ConnectOptions = { command: "everything" };

    await handler.handle({ op: "call", opts, tool: "echo", args: { message: "a" } });
    await handler.handle({ op: "call", opts, tool: "echo", args: { message: "b" } });
    await handler.handle({ op: "tools", opts });

    expect(conn.connects).toBe(1); // one upstream, reused
    expect(handler.size).toBe(1);

    // a DIFFERENT server key → a second upstream
    await handler.handle({ op: "tools", opts: { command: "other" } });
    expect(conn.connects).toBe(2);
    expect(handler.size).toBe(2);

    await handler.closeAll();
    expect(handler.size).toBe(0);
  });

  it("status reports uptime + per-upstream idle, never throwing", async () => {
    const mock = everythingMock();
    const { factory } = mockConnect(mock);
    const handler = createHandler(factory);
    await handler.handle({ op: "tools", opts: { command: "everything" } });

    const res = await handler.handle({ op: "status" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const st = res.result as { uptimeMs: number; servers: Array<{ key: string; idleMs: number }> };
      expect(st.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(st.servers).toHaveLength(1);
      expect(st.servers[0]!.key).toBe("stdio:everything ");
      expect(st.servers[0]!.idleMs).toBeGreaterThanOrEqual(0);
    }
    await handler.closeAll();
  });

  it("returns an error frame (not a throw) for a missing tool name", async () => {
    const { factory } = mockConnect(everythingMock());
    const handler = createHandler(factory);
    const res = await handler.handle({ op: "call", opts: { command: "everything" } } as DaemonRequest);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/tool name/i);
    await handler.closeAll();
  });

  it("reconnects ONCE after a transport-closed error, then succeeds", async () => {
    // The first connected client fails listTools with a "transport closed" error; the
    // handler must drop it and reconnect to a healthy second client transparently.
    let connects = 0;
    const factory = async (_opts: ConnectOptions) => {
      connects++;
      const dead = connects === 1;
      const client = {
        listTools: async () => {
          if (dead) throw new Error("MCP transport is closed");
          return { tools: [{ name: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }] };
        },
        callTool: async (p: { name: string; arguments: Record<string, unknown> }) => ({ content: [{ type: "text", text: String(p.arguments.message) }] }),
      } as unknown as Client;
      return { client, close: async () => {} };
    };
    const handler = createHandler(factory);
    const opts: ConnectOptions = { command: "everything" };

    const res = await handler.handle({ op: "call", opts, tool: "echo", args: { message: "z" } });
    expect(connects).toBe(2); // dropped the dead one, reconnected once
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.result as { content: Array<{ text: string }> }).content[0]!.text).toBe("z");
    await handler.closeAll();
  });
});
