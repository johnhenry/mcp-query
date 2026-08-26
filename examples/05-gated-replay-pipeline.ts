// 05 · Gated replay pipeline — three packages composed: mcp-record's cassette
// stands in for the production server, mcp-gate governs it, and the caller is
// gate.client (an mcp-query MCPClient). Real recorded data, offline and
// deterministic — with the gate's DLP redaction scrubbing it on the way out.
// The demo/staging shape: replay real traffic, governed, with zero credentials.
// Run: npm run example:05   (from the repo root; `npm run build` first)

import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { createGate } from "@johnhenry/mcp-gate";
import { createCassette, recordTransport, replayTransport } from "../packages/mcp-record/src/index.js";

// ── 1. record "production" traffic (the mock plays production) ──
const prod = new MockMCPServer({
  tools: [{ name: "lookup_user", handler: (a) => ({ content: [{ type: "text", text: `user ${a.id}: jane@example.com, SSN 123-45-6789` }] }) }],
});
const cassette = createCassette();
const rec = new MCPClient({ servers: { crm: { transport: () => recordTransport(prod.transport(), cassette) } } });
await rec.connect();
await rec.callTool("crm.lookup_user", { id: 7 });
await rec.close();
await prod.close();
console.log("taped", cassette.interactions.length, "interactions; production server is gone");

// ── 2. front the cassette with a gate ── the upstream is the tape itself.
const gate = await createGate({
  upstreams: { crm: { transport: replayTransport(cassette) } },
  redact: [{ pattern: /\d{3}-\d{2}-\d{4}/g, replacement: "[SSN]" }],
});

// ── 3. query it ── recorded (real) data, replayed offline, redacted by policy.
const r = (await gate.client.callTool("crm.lookup_user", { id: 7 })) as { content: { text: string }[] };
console.log("governed replay:", r.content[0]?.text); // user 7: jane@example.com, SSN [SSN]

await gate.close();
