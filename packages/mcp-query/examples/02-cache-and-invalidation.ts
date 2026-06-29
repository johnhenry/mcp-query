// 02 · Caching & invalidation — reads are cached + de-duped; a mutation invalidates by
// tag so the next read refetches. The TanStack-Query + RTK-Query core of mcp-query.
// Run: npx tsx examples/02-cache-and-invalidation.ts

import { MCPClient, resourceTag } from "../src/index.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import type { CacheKey } from "../src/index.js";

let counter = 0;
const app = new MockMCPServer({
  resources: [{ uri: "app://counter", read: () => ({ text: String(counter) }) }],
  tools: [{ name: "increment", handler: () => ((counter += 1), { content: [{ type: "text", text: "ok" }] }) }],
});

const client = new MCPClient({ servers: { app: { transport: app.transport } } });
await client.connect();

const key: CacheKey = { kind: "resource", server: "app", uri: "app://counter" };
const read = async () => ((await client.readResource("app://counter")) as { contents: { text: string }[] }).contents[0]?.text;

console.log("first read:", await read()); // 0

// Three concurrent reads share ONE request (in-flight de-duplication).
let serverReads = 0;
app.spec.resources![0]!.read = () => ((serverReads += 1), { text: String(counter) });
await Promise.all([read(), read(), read()]);
console.log("server hit once for 3 concurrent reads:", serverReads === 1);
console.log("cache is fresh:", !client.cache.isStale(key));

// A mutation that declares what it invalidates.
await client.callTool("app.increment", {}, { invalidates: [resourceTag("app", "app://counter")] });
console.log("after mutation, entry is stale:", client.cache.isStale(key));
console.log("re-read returns new value:", await read()); // 1

await client.close();
