// Backend 05 · Observability — a MetricsCollector interceptor exporting Prometheus text,
// and client.health() for a readiness probe. Wire these to your /metrics and /healthz.
// Run: npx tsx examples/backend/05-metrics-health.ts

import { MCPClient } from "../../src/index.js";
import { MetricsCollector } from "../../src/metrics/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";

const metrics = new MetricsCollector();
const mock = new MockMCPServer({
  tools: [
    { name: "ok", handler: () => ({ content: [{ type: "text", text: "y" }] }) },
    { name: "boom", handler: () => { throw new Error("x"); } },
  ],
  resources: [{ uri: "m://a", read: () => ({ text: "A" }) }],
});
const client = new MCPClient({ servers: { svc: { transport: mock.transport } }, interceptors: [metrics.interceptor()] });
await client.connect();

await client.callTool("svc.ok", {});
await client.callTool("svc.ok", {});
await client.callTool("svc.boom", {}).catch(() => {});
await client.readResource("m://a");

console.log("snapshot:", metrics.snapshot());
console.log("\n--- GET /metrics ---");
console.log(metrics.prometheus().split("\n").filter((l) => !l.startsWith("#") && l).slice(0, 4).join("\n"));
console.log("\n--- GET /healthz ---");
console.log(await client.health()); // { svc: { state: "ready", pingMs, ok: true } }

await client.close();
