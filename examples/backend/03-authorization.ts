// Backend 03 · Authorization + durable audit. authorize() gates tool calls by an automated
// policy keyed off the principal + the tool's hints (enforcing destructiveHint); onCall
// records every op for a compliance log. Run: npx tsx examples/backend/03-authorization.ts

import { MCPClient } from "../../src/index.js";
import { authorize, denyDestructiveUnless, AuthorizationError } from "../../src/server/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";

const mock = new MockMCPServer({
  tools: [
    { name: "read_report", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "ok" }] }) },
    { name: "delete_account", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "deleted" }] }) },
  ],
});

const client = new MCPClient({
  servers: { svc: { transport: mock.transport } },
  // destructive tools require an explicitly "confirmed" principal context.
  interceptors: [authorize(denyDestructiveUnless((req) => req.context?.meta?.confirmed === true))],
  onCall: (e) => console.log(`  [audit] ${e.principal ?? "-"} ${e.kind} ${e.server}.${e.target} -> ${e.outcome} (${e.ms}ms)`),
});
await client.connect();

const ctx = (meta: Record<string, unknown>) => ({ context: { meta } });

await client.callTool("svc.read_report", {}, ctx({ principal: "guest" })); // allowed (read-only)
try {
  await client.callTool("svc.delete_account", {}, ctx({ principal: "guest" })); // denied (destructive, unconfirmed)
} catch (e) {
  console.log("  denied as expected:", e instanceof AuthorizationError);
}
await client.callTool("svc.delete_account", {}, ctx({ principal: "admin", confirmed: true })); // allowed

console.log("server saw delete only once:", mock.callLog.filter((c) => c.name === "delete_account").length === 1);
await client.close();
