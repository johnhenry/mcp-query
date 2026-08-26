// 04 · Contract drift — mcp-contract snapshotting a server's capability surface,
// then classifying what a "new deploy" changed as breaking vs compatible.
// MockMCPServer.spec is mutable precisely to simulate the second deploy; the
// contract is captured over a plain SDK Client (what the mcp-contract CLI does).
// Run: npm run example:04   (from the repo root; `npm run build` first)

import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { captureContract, diffContract, formatDiff } from "../packages/mcp-contract/src/index.js";

const server = new MockMCPServer({
  tools: [
    {
      name: "search",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      handler: (a) => ({ content: [{ type: "text", text: `found:${a.q}` }] }),
    },
    { name: "summarize", handler: () => ({ content: [{ type: "text", text: "…" }] }) },
  ],
});

async function capture() {
  const client = new Client({ name: "contract", version: "1" }, { capabilities: {} });
  await client.connect(server.transport());
  const contract = await captureContract(client);
  await client.close();
  return contract;
}

// v1: snapshot the surface (in CI you'd commit this JSON next to your code).
const baseline = await capture();
console.log("baseline tools:", baseline.tools.map((t) => t.name));

// "v2 deploys": a required param is added (breaking for existing callers)
// and a whole tool disappears (breaking), while a brand-new tool appears (compatible).
server.spec = {
  tools: [
    {
      name: "search",
      inputSchema: { type: "object", properties: { q: { type: "string" }, lang: { type: "string" } }, required: ["q", "lang"] },
      handler: (a) => ({ content: [{ type: "text", text: `found:${a.q}` }] }),
    },
    { name: "translate", handler: () => ({ content: [{ type: "text", text: "…" }] }) },
  ],
};

const current = await capture();
const drift = diffContract(baseline, current);
console.log(formatDiff(drift, { color: false }));
console.log(`breaking: ${drift.breaking}, compatible: ${drift.compatible}`); // non-zero breaking → fail the CI job

await server.close();
