// Backend 10 · OpenTelemetry tracing — a span per operation with attributes + W3C trace
// context propagated to the server via _meta. Here we pass a tiny console "tracer" so it
// runs without an OTel SDK; in production use @opentelemetry/sdk-node and omit `tracer`.
// Run: npx tsx examples/backend/10-otel.ts

import { MCPClient } from "../../src/index.js";
import { tracing } from "../../src/otel/index.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import type { Span, Tracer } from "@opentelemetry/api";

// A minimal console tracer (stand-in for the real OTel SDK).
const consoleTracer = {
  startActiveSpan: ((name: string, fn: (s: Span) => unknown) => {
    const attrs: Record<string, unknown> = {};
    const span = {
      setAttribute: (k: string, v: unknown) => ((attrs[k] = v), span),
      setStatus: (s: { code: number }) => (console.log(`  [span] ${name} status=${s.code === 1 ? "OK" : "ERROR"}`, attrs), span),
      recordException: () => span,
      end: () => undefined,
    } as unknown as Span;
    return fn(span);
  }) as Tracer["startActiveSpan"],
} as Tracer;

const mock = new MockMCPServer({
  tools: [{ name: "process", handler: (_a, ctx) => ({ content: [{ type: "text", text: `meta=${JSON.stringify(ctx.meta)}` }] }) }],
});
const client = new MCPClient({ servers: { svc: { transport: mock.transport } }, interceptors: [tracing({ tracer: consoleTracer })] });
await client.connect();

const r = (await client.callTool("svc.process", {}, { context: { meta: { principal: "u-7" } } })) as { content: { text: string }[] };
console.log("  server received:", r.content[0]?.text); // principal (+ traceparent if a propagator is configured)

await client.close();
