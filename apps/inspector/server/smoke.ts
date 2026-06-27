// Headless end-to-end smoke: browser transport -> proxy -> stdio server-everything.
// Run with the proxy already up (PROXY_TOKEN=smoke). Deleted before commit.
import { MCPClient } from "mcp-query";
import { WebSocketProxyTransport } from "../src/lib/transport.js";

const client = new MCPClient({
  servers: {
    everything: {
      transport: () =>
        new WebSocketProxyTransport("ws://127.0.0.1:6280", "smoke", {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
    },
  },
});

await client.connect();
console.log("state:", client.serverState("everything"));
console.log("tools:", client.listTools("everything").map((t) => t.name).slice(0, 4).join(", "));
const r = (await client.callTool("everything.echo", { message: "via proxy" })) as { content: { text: string }[] };
console.log("echo:", r.content[0]?.text);
await client.close();
process.exit(0);
