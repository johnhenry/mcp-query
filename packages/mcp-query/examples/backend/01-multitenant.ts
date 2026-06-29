// Backend 01 · Multi-tenancy — one shared client serving many principals. `partition`
// isolates the cache per tenant (no cross-tenant reads); `meta` carries the principal to
// the server as the request `_meta`. Run: npx tsx examples/backend/01-multitenant.ts

import { MCPClient } from "../../src/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { CacheKey } from "../../src/index.js";

const mock = new MockMCPServer({
  resources: [{ uri: "doc://profile", read: () => ({ text: "shared-doc" }) }],
  tools: [{ name: "whoami", handler: (_a, ctx) => ({ content: [{ type: "text", text: JSON.stringify(ctx.meta) }] }) }],
});
const client = new MCPClient({ servers: { app: { transport: mock.transport } } });
await client.connect();

// A per-request view bound to each principal.
const alice = client.scope({ partition: "alice", meta: { principal: "alice" } });
const bob = client.scope({ partition: "bob", meta: { principal: "bob" } });

await alice.readResource("doc://profile");
await bob.readResource("doc://profile");

const has = (partition: string) =>
  !!client.cache.getSnapshot({ kind: "resource", server: "app", uri: "doc://profile", partition } as CacheKey);
console.log("alice cache entry:", has("alice"));
console.log("bob cache entry:  ", has("bob"));
console.log("no shared/leaky entry:", !client.cache.getSnapshot({ kind: "resource", server: "app", uri: "doc://profile" }));

const who = (await alice.callTool("app.whoami", {})) as { content: { text: string }[] };
console.log("server saw _meta:", who.content[0]?.text); // {"principal":"alice"}

await client.close();
