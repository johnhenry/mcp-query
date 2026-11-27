// #100: what a consumer actually receives when the UPSTREAM reports a missing client
// capability. MCPClient wraps the SDK's MissingRequiredClientCapabilityError in an MCPError
// (code -32021) before the gateway sees it, so the gateway's -32004 translation must match that.
import { describe, it, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGatewayHandler, type GatewayOptions } from "../src/server/gateway.js";

const askTool = () => ({
  name: "ask",
  handler: async (_a: Record<string, unknown>, ctx: { elicit: (p: Record<string, unknown>) => Promise<{ action: string }> }) => {
    const r = await ctx.elicit({ message: "q", requestedSchema: { type: "object", properties: {} } });
    return { content: [{ type: "text", text: r.action }] };
  },
});

async function consumerSees(interactions: GatewayOptions["interactions"]) {
  const up = new MockMCPServer({ tools: [askTool()] });
  const upstream = new MCPClient({ servers: { a: { transport: up.transport } }, versions: ["2026-07-28"] }); // gate declares no elicitation
  await upstream.connect();
  const handler = createGatewayHandler(upstream, { interactions });
  const consumer = new Client({ name: "c", version: "1" }, { capabilities: {} }); // consumer declares none either
  await consumer.connect(new StreamableHTTPClientTransport(new URL("http://gw.local/mcp"), { fetch: (u, i) => handler.fetch(new Request(u, i)) }));
  let raw: unknown, seen: unknown;
  try { await upstream.callTool("a.ask", {}); } catch (e) { raw = e; }
  try { await consumer.callTool({ name: "a.ask", arguments: {} }); } catch (e) { seen = e; }
  await consumer.close(); await handler.close(); await upstream.close(); await up.close();
  return { raw: raw as { name: string; code?: number; data?: unknown }, seen: seen as { code?: number; data?: unknown; message: string } };
}

describe("-32021 from an upstream, as the gateway's consumer sees it", () => {
  it("MCPClient hands the gateway an MCPError (-32021), never the raw SDK error", async () => {
    const { raw } = await consumerSees("answer");
    expect(raw.name).toBe("MCPError");
    expect(raw.code).toBe(-32021);
    expect(raw.data).toEqual({ requiredCapabilities: { elicitation: { form: {} } } });
  });

  it('"answer" and "deny": the consumer gets -32004 (the gate\'s own hop lacks the capability), not the upstream\'s -32021', async () => {
    for (const mode of ["answer", "deny"] as const) {
      const { seen } = await consumerSees(mode);
      expect(seen.code, mode).toBe(-32004);
      expect(seen.message, mode).toMatch(/do not declare the required capability/);
    }
  });

  it('"forward": -32021 is left alone, because the missing capability is the consumer\'s own', async () => {
    const { seen } = await consumerSees("forward");
    expect(seen.code).toBe(-32021);
    expect(seen.data).toEqual({ requiredCapabilities: { elicitation: { form: {} } } });
  });
});
