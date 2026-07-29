// 01 · Library mode — embed gate.client directly; never touch gate.server or a transport.
// Useful when you want authz/redact/rateLimit/circuitBreaker/audit governance in front of
// upstream MCP servers *inside* your own process (an agent host, a backend job), without
// exposing a governed MCP endpoint at all — `createGate()` always returns a connected
// `client`; wiring `server` to a transport is only needed for a standalone endpoint.
// Run: npx tsx examples/01-library-mode.ts   (uses the in-memory mock — no network)

import { createGate } from "../src/index.js";
import { MockMCPServer } from "@johnhenry/mcpq/testing";

const docs = new MockMCPServer({
  tools: [
    {
      name: "echo",
      handler: (args) => ({ content: [{ type: "text", text: String(args.message) }] }),
    },
  ],
});

const gate = await createGate({
  upstreams: { docs: { transport: docs.transport } },
  redact: [{ pattern: /\d{3}-\d{2}-\d{4}/g, replacement: "[SSN]" }],
});

// gate.client is a full mcpq MCPClient — call it directly, no server/transport involved.
const r1 = (await gate.client.callTool("docs.echo", { message: "hi" })) as { content: { text: string }[] };
console.log("direct call:", r1.content[0]?.text); // hi

// Multi-tenant embedding: client.scope() sets CallContext directly (no _meta/gateway
// indirection needed in library mode) — pairs with GateConfig.partitionFrom for per-tenant
// rateLimit/circuitBreaker isolation when the same code path serves many tenants.
const acme = gate.client.scope({ partition: "acme", meta: { principal: "alice" } });
const r2 = (await acme.callTool("docs.echo", { message: "scoped to acme" })) as { content: { text: string }[] };
console.log("scoped call:", r2.content[0]?.text); // scoped to acme

// close() tears down the upstream connections; there's no server.close() to call since
// gate.server was never connected to a transport.
await gate.close();
