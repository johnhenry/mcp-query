// Backend 11 · Kitchen sink — assemble a production-shaped client: identity, timeouts,
// L2 cache, a full interceptor stack (metrics → tracing → authz → circuit breaker → rate
// limit), durable audit, retry, and health. This is roughly how a real backend wires it.
// Run: npx tsx examples/backend/11-kitchen-sink.ts

import { MCPClient, MemoryCacheStore } from "../../src/index.js";
import { authorize, denyDestructiveUnless, circuitBreaker, rateLimit } from "../../src/server/index.js";
import { MetricsCollector } from "../../src/metrics/index.js";
import { tracing } from "../../src/otel/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { Span, Tracer } from "@opentelemetry/api";

const noopTracer = { startActiveSpan: ((_n: string, fn: (s: Span) => unknown) => fn({ setAttribute: () => 0, setStatus: () => 0, recordException: () => 0, end: () => 0 } as unknown as Span)) as Tracer["startActiveSpan"] } as Tracer;

const metrics = new MetricsCollector();
const mock = new MockMCPServer({
  tools: [
    { name: "search", annotations: { readOnlyHint: true }, handler: (a) => ({ content: [{ type: "text", text: `hits:${a.q}` }] }) },
    { name: "purge", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "purged" }] }) },
  ],
});

const client = new MCPClient({
  servers: { svc: { transport: mock.transport, lazy: true, idleMs: 30_000 } },
  clientInfo: { name: "my-backend", version: "2.1.0" },
  defaultRequestOptions: { timeout: 10_000 },
  retry: 1,
  cacheStore: new MemoryCacheStore(),
  // Order matters: observe → trace → authorize → protect → execute.
  interceptors: [
    metrics.interceptor(),
    tracing({ tracer: noopTracer }),
    authorize(denyDestructiveUnless((r) => r.context?.meta?.role === "admin")),
    circuitBreaker({ threshold: 5 }),
    rateLimit({ concurrency: 16 }),
  ],
  onCall: (e) => console.log(`  [audit] ${e.principal ?? "-"} ${e.kind} ${e.target} -> ${e.outcome}`),
});
await client.connect();

const user = client.scope({ partition: "acme", meta: { principal: "alice", role: "viewer" } });
const admin = client.scope({ partition: "acme", meta: { principal: "root", role: "admin" } });

const hits = (await user.queryTool("svc.search", { q: "logs" })) as { content: { text: string }[] };
console.log("search ->", hits.content[0]?.text);
await user.callTool("svc.purge", {}).catch((e) => console.log("  viewer purge denied:", e.message));
await admin.callTool("svc.purge", {});

console.log("\nmetrics:", metrics.snapshot());
console.log("health: ", await client.health());

await client.drain(); // graceful shutdown
console.log("drained; state =", client.serverState("svc"));
