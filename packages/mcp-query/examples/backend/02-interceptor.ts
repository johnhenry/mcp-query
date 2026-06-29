// Backend 02 · Interceptors — the seam. A custom logging/timing interceptor that wraps
// every read/call/query, and a short-circuit interceptor that serves from a side cache
// without hitting the server. Run: npx tsx examples/backend/02-interceptor.ts

import { MCPClient } from "../../src/index.js";
import type { RequestInterceptor } from "../../src/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";

const logging: RequestInterceptor = async (op, next) => {
  const start = Date.now();
  try {
    const r = await next(op);
    console.log(`  [trace] ${op.kind} ${op.server}.${op.target} ok ${Date.now() - start}ms`);
    return r;
  } catch (e) {
    console.log(`  [trace] ${op.kind} ${op.server}.${op.target} FAILED: ${(e as Error).message}`);
    throw e;
  }
};

const side = new Map<string, unknown>();
const memoize: RequestInterceptor = async (op, next) => {
  if (op.kind !== "call") return next(op);
  const key = `${op.target}:${JSON.stringify(op.args)}`;
  if (side.has(key)) { console.log("  [memo] hit"); return side.get(key); } // short-circuit
  const r = await next(op);
  side.set(key, r);
  return r;
};

const mock = new MockMCPServer({ tools: [{ name: "expensive", handler: (a) => ({ content: [{ type: "text", text: `result:${a.q}` }] }) }] });
const client = new MCPClient({ servers: { svc: { transport: mock.transport } }, interceptors: [logging, memoize] });
await client.connect();

await client.callTool("svc.expensive", { q: "x" }); // server hit + memoized
await client.callTool("svc.expensive", { q: "x" }); // short-circuited by memoize
console.log("server was called", mock.callLog.length, "time(s)"); // 1

await client.close();
