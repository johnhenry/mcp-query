// 02 · Gate the client — mcp-gate in library mode fronting the same mock:
// authorization policy (deny globs), DLP redaction, and the audit sink, all
// in-process. gate.client IS an mcp-query MCPClient, so everything from 01
// works through it unchanged — just governed.
// Run: npm run example:02   (from the repo root; `npm run build` first)

import { createGate } from "@johnhenry/mcp-gate";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";

const crm = new MockMCPServer({
  tools: [
    { name: "lookup_user", handler: (a) => ({ content: [{ type: "text", text: `user ${a.id}: jane@example.com, SSN 123-45-6789` }] }) },
    { name: "delete_user", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "deleted" }] }) },
  ],
});

const auditLog: string[] = [];
const gate = await createGate({
  upstreams: { crm: { transport: crm.transport } },
  policy: { denyDestructive: true },
  redact: [{ pattern: /\d{3}-\d{2}-\d{4}/g, replacement: "[SSN]" }],
  audit: (entry) => auditLog.push(`${entry.outcome} ${entry.kind} ${entry.target}`),
});

// Allowed call — but the SSN in the result is redacted before the caller sees it.
const r = (await gate.client.callTool("crm.lookup_user", { id: 7 })) as { content: { text: string }[] };
console.log("lookup:", r.content[0]?.text); // ... SSN [SSN]

// Denied call — destructiveHint tools are refused by policy, and audited as such.
await gate.client.callTool("crm.delete_user", { id: 7 }).catch((err) => console.log("delete:", String(err)));

console.log("audit:", auditLog);

await gate.close();
await crm.close();
