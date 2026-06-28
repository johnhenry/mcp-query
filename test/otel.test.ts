import { describe, it, expect } from "vitest";
import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { tracing } from "../src/otel/index.js";

// A minimal fake tracer that records the spans the interceptor creates.
function fakeTracer() {
  const spans: Array<{ name: string; attrs: Record<string, unknown>; status?: number; ended: boolean }> = [];
  const tracer: Pick<Tracer, "startActiveSpan"> = {
    startActiveSpan: ((name: string, fn: (s: Span) => unknown) => {
      const rec = { name, attrs: {} as Record<string, unknown>, status: undefined as number | undefined, ended: false };
      spans.push(rec);
      const span = {
        setAttribute: (k: string, v: unknown) => ((rec.attrs[k] = v), span),
        setStatus: (s: { code: number }) => ((rec.status = s.code), span),
        recordException: () => span,
        end: () => ((rec.ended = true), undefined),
      } as unknown as Span;
      return fn(span);
    }) as Tracer["startActiveSpan"],
  };
  return { tracer: tracer as Tracer, spans };
}

describe("otel tracing interceptor", () => {
  it("opens a span per op with attributes and an OK status", async () => {
    const { tracer, spans } = fakeTracer();
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [tracing({ tracer })] });
    await client.connect();

    await client.callTool("s.echo", { msg: "x" }, { context: { meta: { principal: "u1" } } });

    const span = spans.find((s) => s.name.includes("call"))!;
    expect(span.name).toBe("mcp.call s.echo");
    expect(span.attrs).toMatchObject({ "mcp.server": "s", "mcp.operation": "call", "mcp.target": "echo", "mcp.principal": "u1" });
    expect(span.status).toBe(SpanStatusCode.OK);
    expect(span.ended).toBe(true);
    await client.close();
  });

  it("marks the span ERROR and ends it on failure", async () => {
    const { tracer, spans } = fakeTracer();
    const mock = new MockMCPServer({ tools: [{ name: "boom", handler: () => { throw new Error("nope"); } }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, interceptors: [tracing({ tracer })] });
    await client.connect();

    await expect(client.callTool("s.boom", {})).rejects.toBeTruthy();
    const span = spans.find((s) => s.name.includes("boom"))!;
    expect(span.status).toBe(SpanStatusCode.ERROR);
    expect(span.ended).toBe(true);
    await client.close();
  });
});
