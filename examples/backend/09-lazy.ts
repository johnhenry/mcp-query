// Backend 09 · Lazy connect + idle eviction — connect upstreams on first use (not eagerly),
// and drop idle ones to free resources; they re-wake on the next call.
// Run: npx tsx examples/backend/09-lazy.ts

import { MCPClient } from "../../src/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mock = new MockMCPServer({ tools: [{ name: "ping", handler: () => ({ content: [{ type: "text", text: "pong" }] }) }] });
const client = new MCPClient({
  servers: { svc: { transport: mock.transport, lazy: true, idleMs: 40 } },
});

await client.connect(); // eager phase — lazy server stays idle
console.log("after connect(): state =", client.serverState("svc"), "| upstream connects:", mock.connectCount); // idle | 0

await client.callTool("svc.ping", {}); // first use wakes it
console.log("after first call: state =", client.serverState("svc"), "| connects:", mock.connectCount); // ready | 1

await sleep(80); // idle past idleMs
console.log("after idle:       state =", client.serverState("svc")); // idle (slept)

await client.callTool("svc.ping", {}); // re-wakes
console.log("after re-use:     state =", client.serverState("svc"), "| connects:", mock.connectCount); // ready | 2

await client.close();
