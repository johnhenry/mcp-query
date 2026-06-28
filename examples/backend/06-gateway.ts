// Backend 06 · Gateway — re-serve aggregated, namespaced upstreams as ONE MCP server. The
// deployable "single endpoint fronting many." Here a plain SDK Client consumes the gateway.
// Run: npx tsx examples/backend/06-gateway.ts

import { MCPClient } from "../../src/index.js";
import { createGateway } from "../../src/server/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Two upstreams behind one mcp-query client.
const github = new MockMCPServer({ tools: [{ name: "create_issue", handler: (a) => ({ content: [{ type: "text", text: `#${a.title}` }] }) }] });
const fs = new MockMCPServer({ resources: [{ uri: "file:///notes", read: () => ({ text: "buy milk" }) }] });
const upstream = new MCPClient({ servers: { github: { transport: github.transport }, fs: { transport: fs.transport } } });
await upstream.connect();

// Expose them as one server.
const gateway = createGateway(upstream, { namespace: true });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await gateway.connect(serverT);

// A downstream consumer talks to the gateway as if it were a single MCP server.
const consumer = new Client({ name: "consumer", version: "1" }, { capabilities: {} });
await consumer.connect(clientT);

console.log("gateway tools:", (await consumer.listTools()).tools.map((t) => t.name)); // [ 'github.create_issue' ]
console.log("gateway resources:", (await consumer.listResources()).resources.map((r) => r.uri)); // [ 'file:///notes' ]
const issue = (await consumer.callTool({ name: "github.create_issue", arguments: { title: "bug" } })) as { content: { text: string }[] };
console.log("routed call ->", issue.content[0]?.text); // #bug
const notes = (await consumer.readResource({ uri: "file:///notes" })) as { contents: { text: string }[] };
console.log("routed read ->", notes.contents[0]?.text); // buy milk

await consumer.close();
await upstream.close();
