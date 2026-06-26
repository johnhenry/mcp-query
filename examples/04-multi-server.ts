// 04 · Multi-server — one client multiplexes several servers: routing by namespace and
// by URI scheme, with isolated failure (a dead server doesn't sink the others).
// Run: npx tsx examples/04-multi-server.ts

import { MCPClient } from "../src/index.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const fs = new MockMCPServer({
  resources: [{ uri: "file:///notes.txt", read: () => ({ text: "buy milk" }) }],
  tools: [{ name: "read_file", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "buy milk" }] }) }],
});
const github = new MockMCPServer({
  tools: [{ name: "create_issue", handler: (a) => ({ content: [{ type: "text", text: `#${(a as { title: string }).title}` }] }) }],
});

const client = new MCPClient({
  servers: {
    fs: { transport: fs.transport },
    github: { transport: github.transport },
    // A server that won't start — connect() isolates the failure.
    broken: { transport: () => { throw new Error("cannot spawn"); }, maxRetries: 0 },
  },
  schemeMap: { file: "fs" }, // route file:// URIs to the fs server
});

await client.connect();
console.log("states:", client.connections().map((c) => `${c.name}=${c.state}`).join(", "));

// Unique tool name → routed automatically; scheme → routed by schemeMap.
console.log("file read:", ((await client.readResource("file:///notes.txt")) as { contents: { text: string }[] }).contents[0]?.text);
console.log("namespaced call:", ((await client.callTool("github.create_issue", { title: "bug" })) as { content: { text: string }[] }).content[0]?.text);

// The broken server is isolated; fs + github keep working.
console.log("broken server state:", client.serverState("broken")); // failed

await client.close();
