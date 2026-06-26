// 01 · Minimal — the smallest useful program: connect, list, call one tool.
// Run: npx tsx examples/01-minimal.ts   (uses the in-memory mock — no network)

import { MCPClient } from "../src/index.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const calc = new MockMCPServer({
  tools: [
    {
      name: "add",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      handler: (args) => ({ content: [{ type: "text", text: String((args.a as number) + (args.b as number)) }] }),
    },
  ],
});

const client = new MCPClient({ servers: { calc: { transport: calc.transport } } });
await client.connect();

console.log("tools:", client.listTools("calc").map((t) => t.name)); // [ 'add' ]
const r = (await client.callTool("calc.add", { a: 2, b: 3 })) as { content: { text: string }[] };
console.log("2 + 3 =", r.content[0]?.text); // 5

await client.close();
