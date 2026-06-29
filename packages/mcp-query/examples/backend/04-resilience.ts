// Backend 04 · Resilience — a circuit breaker (fail fast after repeated failures, then
// half-open) and a concurrency limiter (backpressure) as interceptors.
// Run: npx tsx examples/backend/04-resilience.ts

import { MCPClient } from "../../src/index.js";
import { circuitBreaker, rateLimit, CircuitOpenError } from "../../src/server/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";

let clock = 0;
const mock = new MockMCPServer({
  tools: [
    { name: "flaky", handler: () => { throw new Error("upstream down"); } },
    { name: "slow", handler: async () => (await new Promise((r) => setTimeout(r, 20)), { content: [{ type: "text", text: "ok" }] }) },
  ],
});

const client = new MCPClient({
  servers: { svc: { transport: mock.transport } },
  interceptors: [circuitBreaker({ threshold: 2, cooldownMs: 100, now: () => clock }), rateLimit({ concurrency: 2 })],
});
await client.connect();

// circuit breaker
await client.callTool("svc.flaky", {}).catch(() => {}); // fail 1
await client.callTool("svc.flaky", {}).catch(() => {}); // fail 2 -> OPEN
const fast = await client.callTool("svc.flaky", {}).catch((e) => e);
console.log("circuit open -> fast fail:", fast instanceof CircuitOpenError, "(server hit only", mock.callLog.length, "times)");
clock = 200; // past cooldown -> half-open allows a trial
await client.callTool("svc.flaky", {}).catch(() => {});
console.log("half-open trial reached server:", mock.callLog.length === 3);

// concurrency limiter (advance the clock so the breaker isn't open for these calls)
clock = 1000;
let active = 0, peak = 0;
mock.spec.tools![1]!.handler = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active--; return { content: [{ type: "text", text: "ok" }] }; };
await Promise.all(Array.from({ length: 6 }, () => client.callTool("svc.slow", {})));
console.log("max concurrent never exceeded 2:", peak <= 2, `(peak ${peak})`);

await client.close();
