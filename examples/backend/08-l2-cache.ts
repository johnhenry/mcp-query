// Backend 08 · Multi-node cache — a shared async L2 store behind each node's sync L1.
// Node B serves a read from L2 (cached by A) without hitting its own server, and A's
// declared invalidation fans out to B. Run: npx tsx examples/backend/08-l2-cache.ts
//
// (MemoryCacheStore models the shared store in-process; use mcp-query/redis across machines.)

import { MCPClient, MemoryCacheStore, resourceTag } from "../../src/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { CacheKey } from "../../src/index.js";

const store = new MemoryCacheStore(); // shared L2

let bReads = 0;
const aMock = new MockMCPServer({
  resources: [{ uri: "shared://doc", read: () => ({ text: "value-from-A" }) }],
  tools: [{ name: "touch", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
});
const bMock = new MockMCPServer({ resources: [{ uri: "shared://doc", read: () => ((bReads += 1), { text: "B-own" }) }] });

const A = new MCPClient({ servers: { s: { transport: aMock.transport } }, cacheStore: store });
const B = new MCPClient({ servers: { s: { transport: bMock.transport } }, cacheStore: store });
await A.connect();
await B.connect();

const a = (await A.readResource("shared://doc")) as { contents: { text: string }[] };
console.log("A read (network):", a.contents[0]?.text);

const b = (await B.readResource("shared://doc")) as { contents: { text: string }[] };
console.log("B read (from L2):", b.contents[0]?.text, "— B's server hit:", bReads, "times"); // value-from-A, 0

const keyB: CacheKey = { kind: "resource", server: "s", uri: "shared://doc" };
console.log("B fresh before invalidation:", !B.cache.isStale(keyB));
await A.callTool("s.touch", {}, { invalidates: [resourceTag("s", "shared://doc")] }); // broadcasts
await new Promise((r) => setTimeout(r, 10));
console.log("B stale after A's invalidation:", B.cache.isStale(keyB)); // true

await A.close();
await B.close();
