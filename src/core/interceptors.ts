// Request interceptor chain — the server-side seam. A Koa/Connect-style onion around the
// *logical* operation (read / call / query), not the transport (that seam already exists via
// instrumentTransport). Interceptors can short-circuit (return or throw without calling
// next), observe result/error/timing, and mutate the operation (context, args) before it
// runs. Authorization, tracing, rate-limiting, redaction all hang here.

import type { CallContext } from "./client.js";
import type { Tool } from "./types.js";

export type OperationKind = "read" | "call" | "query";

export interface Operation {
  kind: OperationKind;
  server: string;
  /** Resource URI (read) or tool name (call/query). */
  target: string;
  /** Tool arguments (call/query); undefined for reads. Mutable. */
  args?: Record<string, unknown>;
  /** The resolved tool definition (call/query) — read annotations (destructive/read-only) here. */
  def?: Tool;
  /** Per-call context (partition + meta/principal). Mutable. */
  context?: CallContext;
  /** Scratch bag for interceptors to thread data down the chain (e.g. a span, start time). */
  readonly state: Record<string, unknown>;
}

/** Invoke the next interceptor (or the real operation at the end of the chain). */
export type Next = (op: Operation) => Promise<unknown>;

/** `(op, next) => next(op)` — wrap, mutate, short-circuit, or observe. */
export type RequestInterceptor = (op: Operation, next: Next) => Promise<unknown>;

/** Run `op` through the chain, with `exec` as the innermost (the actual operation). */
export function runInterceptors(
  interceptors: readonly RequestInterceptor[],
  op: Operation,
  exec: Next,
): Promise<unknown> {
  const dispatch = (i: number, o: Operation): Promise<unknown> => {
    const fn = i === interceptors.length ? exec : interceptors[i]!;
    return fn(o, (nextOp) => dispatch(i + 1, nextOp));
  };
  return dispatch(0, op);
}
