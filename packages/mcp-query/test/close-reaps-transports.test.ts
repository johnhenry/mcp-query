// #23: ServerConnection must close EVERY transport it ever created (not just the live one),
// so a replaced/leaked transport (e.g. a stdio child from before a reconnect) can't outlive
// client.close().
import { describe, it, expect } from "vitest";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { MCPClient } from "../src/core/client.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("client.close() closes every transport the connection created", () => {
  it("including the one replaced by a reconnect", async () => {
    const created: { transport: InMemoryTransport; server: InMemoryTransport; closes: number }[] = [];
    const client = new MCPClient({
      servers: {
        s: {
          initialBackoffMs: 5,
          transport: () => {
            const [clientT, serverT] = InMemoryTransport.createLinkedPair();
            const server = new Server({ name: "m", version: "1" }, { capabilities: { tools: {} } });
            server.setRequestHandler("tools/list", async () => ({ tools: [] }));
            void server.connect(serverT);
            const rec = { transport: clientT, server: serverT, closes: 0 };
            const orig = clientT.close.bind(clientT);
            clientT.close = async () => {
              rec.closes++;
              return orig();
            };
            created.push(rec);
            return clientT;
          },
        },
      } as never,
    });
    await client.connect();
    expect(created).toHaveLength(1);

    await created[0]!.server.close(); // drop the link -> connection reconnects on a fresh transport
    for (let i = 0; i < 100 && created.length < 2; i++) await tick(20);
    expect(created.length).toBeGreaterThanOrEqual(2);
    await tick(100);

    await client.close();
    expect(created.map((c) => c.closes > 0)).toEqual(created.map(() => true));
  });

  it("closes a transport whose start() failed", async () => {
    let closes = 0;
    const client = new MCPClient({
      servers: {
        s: {
          maxRetries: 0,
          transport: () => {
            const [clientT] = InMemoryTransport.createLinkedPair();
            clientT.start = async () => {
              throw new Error("boom"); // e.g. a stdio child spawned, then start() rejected
            };
            const orig = clientT.close.bind(clientT);
            clientT.close = async () => {
              closes++;
              return orig();
            };
            return clientT;
          },
        },
      } as never,
    });
    await client.connect().catch(() => {});
    await client.close();
    expect(closes).toBeGreaterThan(0);
  });
});
