// Regression tests for two connection-layer fixes found by the stress suite:
//   1. relist ordering — concurrent list_changed re-lists must never let a stale
//      response overwrite a newer one (generation guard in ServerConnection.relist)
//   2. state accuracy — a dropped live connection reports "reconnecting" during the
//      retry backoff window instead of continuing to claim "ready"

import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("relist ordering under concurrent list_changed", () => {
  it("a slow stale re-list response never overwrites a newer one", async () => {
    // Hand-rolled server: the FIRST tools/list response is delayed past the second, so
    // without the generation guard the stale catalog would be applied last and stick.
    let listCalls = 0;
    let active: Server | undefined;
    const build = () => {
      const server = new Server({ name: "m", version: "1" }, { capabilities: { tools: { listChanged: true } } });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        const call = ++listCalls;
        const tools = [{ name: `tool-gen-${call}`, inputSchema: { type: "object" } }];
        if (call === 2) await tick(80); // 2nd list (1st storm re-list) arrives LAST
        return { tools };
      });
      server.setRequestHandler(CallToolRequestSchema, () => ({ content: [] }));
      return server;
    };
    const client = new MCPClient({
      servers: {
        s: {
          transport: () => {
            const [clientT, serverT] = InMemoryTransport.createLinkedPair();
            active = build();
            void active.connect(serverT);
            return clientT;
          },
        },
      },
    });
    await client.connect(); // consumes list call #1

    // Two rapid list_changed → re-list #2 (slow) and #3 (fast).
    await active!.notification({ method: "notifications/tools/list_changed" });
    await active!.notification({ method: "notifications/tools/list_changed" });
    await tick(150); // let the slow stale response land after the fast one

    expect(listCalls).toBeGreaterThanOrEqual(3);
    // The newest re-list (#3) must win even though #2's response arrived last.
    expect(client.listTools("s").map((t) => t.name)).toEqual(["tool-gen-3"]);

    await client.close();
  });
});

describe("state accuracy across a dropped connection", () => {
  it("reports 'reconnecting' during the retry backoff window, not 'ready'", async () => {
    const server = new MockMCPServer({
      tools: [{ name: "t", handler: () => ({ content: [] }) }],
    });
    const client = new MCPClient({
      // Long retry delay so the backoff window is observable.
      servers: { s: { transport: server.transport, retryDelay: () => 5_000 } },
    });
    await client.connect();
    expect(client.serverState("s")).toBe("ready");

    await client.connections()[0]!.sdk.transport?.close();
    await tick(20);
    // The attempt hasn't started (5s delay) — but the connection is NOT ready.
    expect(client.serverState("s")).toBe("reconnecting");

    await client.close();
  });
});
