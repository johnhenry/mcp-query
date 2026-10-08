// A minimal stdio MCP server that refuses to die politely: it ignores SIGTERM and
// SIGHUP, and keeps the event loop alive after stdin closes. Only SIGKILL stops it.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
setInterval(() => {}, 1000);

const server = new McpServer({ name: "stubborn", version: "1.0.0" });
server.registerTool("ping", { description: "pong" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
await server.connect(new StdioServerTransport());
