// OpenTelemetry tracing interceptor. A span per operation, with W3C trace context
// propagated to the server via the request `_meta` (closing the loop with CallContext.meta).
// `@opentelemetry/api` is an OPTIONAL peer dependency — only needed if you import this
// module. Import from `mcp-query/otel`.

import { trace, context as otelContext, propagation, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { RequestInterceptor } from "../core/interceptors.js";

export interface TracingOptions {
  /** A tracer to use; defaults to the global tracer named "mcp-query". */
  tracer?: Tracer;
  /** Propagate W3C traceparent to the server via `context.meta`. Default true. */
  propagate?: boolean;
}

export function tracing(opts: TracingOptions = {}): RequestInterceptor {
  const tracer = opts.tracer ?? trace.getTracer("mcp-query");
  const propagate = opts.propagate ?? true;

  return (op, next) =>
    tracer.startActiveSpan(`mcp.${op.kind} ${op.server}.${op.target}`, async (span) => {
      span.setAttribute("mcp.server", op.server);
      span.setAttribute("mcp.operation", op.kind);
      span.setAttribute("mcp.target", op.target);
      const principal = (op.context?.meta as { principal?: unknown } | undefined)?.principal;
      if (principal != null) span.setAttribute("mcp.principal", String(principal));

      if (propagate) {
        const carrier: Record<string, string> = {};
        propagation.inject(otelContext.active(), carrier); // e.g. { traceparent: "00-…" }
        if (Object.keys(carrier).length) op.context = { ...op.context, meta: { ...op.context?.meta, ...carrier } };
      }

      try {
        const r = await next(op);
        span.setStatus({ code: SpanStatusCode.OK });
        return r;
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.end();
      }
    });
}
