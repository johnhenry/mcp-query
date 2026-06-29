// 06 · Alongside another client — mcp-query is a *non-agentic data layer*; it doesn't
// replace your agent or other MCP clients, it runs beside them. Here two independent
// clients share one stateful server:
//
//   • Client A = mcp-query — the reactive read/cache/UI layer (a human dashboard).
//   • Client B = a raw @modelcontextprotocol/sdk Client — stands in for an LLM agent
//     (or Claude Desktop, Vercel AI SDK, LangChain, …) that *acts* by calling tools.
//
// When B mutates shared state, the server pushes notifications/resources/updated to A,
// so mcp-query's cache stays live with what the other client did — no coupling between
// them, just the MCP protocol. (This models an HTTP MCP server with multiple sessions;
// for stdio each client gets its own process, so they wouldn't share state.)
//
// Run: npx tsx examples/06-alongside-another-client.ts

import { MCPClient } from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── one shared backend; many server "sessions" read/write it and broadcast changes ──
const backend = { status: "draft", listeners: new Set<() => void>() };
const setStatus = (v: string) => {
  backend.status = v;
  for (const l of backend.listeners) l();
};

function sessionTransport(): Transport {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "docs", version: "1.0.0" },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );
  const subscribed = new Set<string>();

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "set_status", inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    setStatus(String((req.params.arguments as { status: string }).status));
    return { content: [{ type: "text", text: "ok" }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: "doc://status", name: "status" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, () => ({
    contents: [{ uri: "doc://status", mimeType: "text/plain", text: backend.status }],
  }));
  server.setRequestHandler(SubscribeRequestSchema, (req) => (subscribed.add(req.params.uri), {}));
  server.setRequestHandler(UnsubscribeRequestSchema, (req) => (subscribed.delete(req.params.uri), {}));

  // Broadcast: when the shared backend changes, push to THIS session if it's subscribed.
  backend.listeners.add(() => {
    if (subscribed.has("doc://status")) {
      void server.notification({ method: "notifications/resources/updated", params: { uri: "doc://status" } });
    }
  });

  void server.connect(serverT);
  return clientT;
}

const readStatus = async (ui: MCPClient) =>
  ((await ui.readResource("doc://status", { subscribe: true })) as { contents: { text: string }[] }).contents[0]?.text;

// ── Client A: mcp-query (the dashboard) ──
const ui = new MCPClient({ servers: { docs: { transport: sessionTransport } } });
await ui.connect();
console.log("[mcp-query] dashboard shows:", await readStatus(ui)); // draft

// ── Client B: a different MCP client (the "agent") acting on the same backend ──
const agent = new Client({ name: "agent", version: "1.0.0" }, { capabilities: {} });
await agent.connect(sessionTransport());
console.log("[agent] publishing…");
await agent.callTool({ name: "set_status", arguments: { status: "published" } });

// mcp-query learns about the agent's action through the server's push — not by polling,
// and without the two clients knowing about each other.
await sleep(20);
console.log("[mcp-query] cache went stale from the agent's change:", ui.cache.isStale({ kind: "resource", server: "docs", uri: "doc://status" }));
console.log("[mcp-query] dashboard now shows:", await readStatus(ui)); // published

await agent.close();
await ui.close();
