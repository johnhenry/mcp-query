// Minimal stdio MCP server for the bridge tests: one `echo` tool.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool("echo", { description: "echo", inputSchema: z.object({ msg: z.string() }) }, async ({ msg }) => ({
  content: [{ type: "text", text: `echo:${msg}` }],
}));
await server.connect(new StdioServerTransport());
