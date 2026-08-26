// 01 · Client + in-process server — the pair every other root example builds on:
// a MockMCPServer (in-memory Streamable HTTP, no subprocess, no network) queried
// by an MCPClient. The sibling packages each wrap this pair a different way:
// gate governs it, record tapes it, contract snapshots it, tanstack renders it.
// Run: npm run example:01   (from the repo root; `npm run build` first)

import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";

const calc = new MockMCPServer({
  tools: [
    {
      name: "add",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      handler: (args) => ({ content: [{ type: "text", text: String((args.a as number) + (args.b as number)) }] }),
    },
  ],
  resources: [{ uri: "mem://motd", name: "motd", read: () => ({ text: "hello from the mock" }) }],
});

const client = new MCPClient({ servers: { calc: { transport: calc.transport } } });
await client.connect();

// Lists are synchronous cache reads after connect; calls are namespaced server.tool.
console.log("tools:", client.listTools("calc").map((t) => t.name)); // [ 'add' ]
const sum = (await client.callTool("calc.add", { a: 2, b: 3 })) as { content: { text: string }[] };
console.log("2 + 3 =", sum.content[0]?.text); // 5

const motd = (await client.readResource("mem://motd")) as { contents: { text?: string }[] };
console.log("motd:", motd.contents[0]?.text);

await client.close();
await calc.close();
