// Runnable example: drive a real MCP server (@modelcontextprotocol/server-everything)
// with mcp-query's framework-agnostic core — no React, no agent, no LLM.
//
//   npm run example:node
//
// Shows: connect + capability negotiation, listing tools/resources/templates,
// calling a tool, reading a resource, and generating typed bindings from tools/list.

import { MCPClient } from "../src/index.js";
import { generateFromClient } from "../src/codegen/cli.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new MCPClient({
  servers: {
    everything: {
      transport: () =>
        new StdioClientTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] }),
    },
  },
});

await client.connect();
console.log("server state:", client.serverState("everything"));

const tools = client.listTools("everything");
console.log(`\n${tools.length} tools:`, tools.map((t) => t.name).join(", "));

const resources = client.listResources("everything");
console.log(`${resources.length} resources, ${client.listResourceTemplates("everything").length} templates`);

// Call a tool — echo round-trips a string.
const echo = (await client.callTool("everything.echo", { message: "hello from mcp-query" })) as {
  content: { text?: string }[];
};
console.log("\necho ->", echo.content[0]?.text);

// Read a resource (cached + URI-tagged).
if (resources[0]) {
  await client.readResource(resources[0].uri);
  const cached = client.cache.getSnapshot({ kind: "resource", server: "everything", uri: resources[0].uri });
  console.log(`read ${resources[0].uri} -> cache status ${cached?.status}, tags [${[...(cached?.tags ?? [])].join(", ")}]`);
}

// Codegen typed bindings straight from the live server.
const conn = client.connection("everything")!;
const generated = await generateFromClient(conn.sdk);
console.log("\n--- generated types (first lines) ---");
console.log(generated.split("\n").slice(0, 12).join("\n"));

await client.close();
console.log("\ndone.");
