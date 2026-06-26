// 08 · WebMCP bridge (EXPERIMENTAL · illustrative) — both directions in one browser app.
// WebMCP (`document.modelContext`) makes the *page* an agent-controllable server; mcp-query
// is the *client* of real servers. These adapters connect the two. Tools-only + draft API
// (see docs/webmcp.md). Needs a WebMCP-capable browser to run.

import { MCPClient, isDestructive } from "../src/index.js";
import { bridgeToWebMCP, webMcpToolServer } from "../src/webmcp/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new MCPClient({
  servers: {
    // A real backend MCP server (stdio/HTTP).
    backend: { transport: () => new StreamableHTTPClientTransport(new URL("https://example.com/mcp")) },
    // A) Consume the page's own WebMCP tools as just another mcp-query server — so they get
    //    caching, the broker, and devtools like everything else.
    page: webMcpToolServer(), // defaults to document.modelContext
  },
});
await client.connect();

// B) Expose the backend server's tools to the in-browser agent via WebMCP. Every agent
//    invocation flows through client.callTool — so the cache, invalidation, and (if
//    configured) the broker apply. Destructive tools require a human confirm.
const stop = bridgeToWebMCP(client, "backend", {
  confirm: async ({ tool, args }) =>
    !isDestructive(tool) || window.confirm(`Agent wants to run ${tool.name}(${JSON.stringify(args)}). Allow?`),
});

// The agent in the browser can now discover & call the backend's tools; the page's own
// tools are simultaneously available to mcp-query. Call stop() to unregister the bridge.
void stop;
