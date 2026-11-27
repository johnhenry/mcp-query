// Step 0 for #82: characterize what a consumer behind the gateway sees today when an
// upstream tool needs an elicitation. Both eras, both hops.
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 }); // cold start of the first rig is slow on a loaded machine
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGateway, createGatewayHandler } from "../src/server/gateway.js";

function handlerTransport(handler: { fetch: (r: Request) => Promise<Response> }) {
  return new StreamableHTTPClientTransport(new URL("http://gw.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
}

const askTool = () => ({
  name: "ask",
  handler: async (_a: Record<string, unknown>, ctx: { elicit: (p: Record<string, unknown>) => Promise<{ action: string; content?: unknown }> }) => {
    const r = await ctx.elicit({ message: "Pick a colour", requestedSchema: { type: "object", properties: { colour: { type: "string" } } } });
    return { content: [{ type: "text", text: `${r.action}:${JSON.stringify(r.content ?? null)}` }] };
  },
});

describe("#82 step 0 — current behaviour with an upstream elicitation", () => {
  it("modern era: the consumer's elicitation handler is NEVER asked; upstream cannot ask, consumer sees an error", async () => {
    const up = new MockMCPServer({ tools: [askTool()] });
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, versions: ["2026-07-28"] }); // no handlers
    await upstream.connect();
    const handler = createGatewayHandler(upstream);
    const asked: unknown[] = [];
    const consumer = new MCPClient({
      servers: { gw: { transport: () => handlerTransport(handler) } },
      versions: ["2026-07-28"],
      handlers: { elicitation: async (req) => (asked.push(req), { action: "accept", content: { colour: "red" } }) },
    });
    await consumer.connect();
    expect(consumer.connections()[0]!.name).toBe("gw");
    let out: unknown, err: unknown;
    try { out = await consumer.callTool("gw.a.ask", {}); } catch (e) { err = e; }
    // Observed: the upstream refuses to ask (no elicitation capability on the gate's hop); the consumer sees an error.
    expect(out).toBeUndefined();
    expect(String((err as Error)?.message)).toMatch(/Cannot request input .* do not declare the required capability/);
    expect(asked).toHaveLength(0);
    await consumer.close(); await handler.close(); await upstream.close(); await up.close();
  });

  it("legacy era: the consumer's elicitation handler is NEVER asked", async () => {
    const up = new MockMCPServer({ tools: [askTool()] });
    const upstream = new MCPClient({ servers: { a: { transport: up.transport } } }); // legacy, no handlers
    await upstream.connect();
    const gateway = createGateway(upstream);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await gateway.connect(st);
    const asked: unknown[] = [];
    const consumer = new Client({ name: "c", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    consumer.setRequestHandler("elicitation/create", async (req) => (asked.push(req), { action: "accept", content: { colour: "red" } }));
    await consumer.connect(ct);
    let out: unknown, err: unknown;
    try { out = await consumer.callTool({ name: "a.ask", arguments: {} }); } catch (e) { err = e; }
    // Observed: an isError tool result saying the client "did not declare the required capability".
    expect(err).toBeUndefined();
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(asked).toHaveLength(0);
    await consumer.close(); await upstream.close(); await up.close();
  });
});
