// Backend 07 · Per-principal sessions + graceful drain. SessionManager pools one isolated
// MCPClient per principal (own connections/credentials) with idle eviction; client.drain()
// for SIGTERM. Run: npx tsx examples/backend/07-sessions.ts

import { MCPClient } from "../../src/index.js";
import { SessionManager } from "../../src/session/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";

let virtualNow = 0;
let created = 0;

const sessions = new SessionManager({
  now: () => virtualNow,
  ttl: 100,
  // In reality: build a client with this principal's servers/credentials.
  create: async (principal) => {
    created++;
    const mock = new MockMCPServer({ tools: [{ name: "whoami", handler: () => ({ content: [{ type: "text", text: principal }] }) }] });
    const c = new MCPClient({ servers: { svc: { transport: mock.transport } } });
    await c.connect();
    return c;
  },
});

// Each request resolves the principal's own client.
async function handle(principal: string) {
  const client = await sessions.get(principal);
  const r = (await client.callTool("svc.whoami", {})) as { content: { text: string }[] };
  return r.content[0]?.text;
}

console.log("alice:", await handle("alice"));
console.log("bob:  ", await handle("bob"));
console.log("alice again:", await handle("alice"));
console.log("clients created:", created, "| live sessions:", sessions.size()); // 2 | 2

virtualNow = 250; // idle past ttl
await sessions.sweep(); // evicts + drains idle clients
console.log("after idle sweep, live sessions:", sessions.size()); // 0

await sessions.closeAll(); // graceful shutdown (drains everything)
