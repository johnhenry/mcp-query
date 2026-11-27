// Request interceptor chain — the server-side seam. A Koa/Connect-style onion around the
// *logical* operation (read / call / query), not the transport (that seam already exists via
// instrumentTransport). Interceptors can short-circuit (return or throw without calling
// next), observe result/error/timing, and mutate the operation (context, args) before it
// runs. Authorization, tracing, rate-limiting, redaction all hang here.
//
// Structurally compatible with @johnhenry/agent-query-core's own Operation (issue #18):
// same field set, `peer` instead of `server` (matching core's generalization), just with
// mcp-query's own narrower/typed `kind`/`def`/`context` in place of core's generic
// string/unknown/OperationContext — so a value here upcasts cleanly to core's Operation,
// without core's generic types leaking into every interceptor implementation (authorize.ts
// etc. want a real `Tool`/`CallContext`, not `unknown`). The dispatch loop itself
// (runInterceptors) is trivial and kept local rather than re-exported, since core's version
// is hardcoded to its own (wider) Operation type.

import type { CallContext } from "./client.js";
import type { Tool } from "./types.js";
import type { ToolInteraction } from "./interaction.js";

/**
 * What an {@link Operation} is. `read`/`call`/`query` are the original kinds; the rest were added
 * additively (#90), so an interceptor written against the first three keeps working: it sees the
 * new kinds, passes them to `next(op)` untouched, and behaves exactly as before.
 *
 * - `read`   resources/read (`target` = URI)
 * - `call`   tools/call (`target` = tool name)
 * - `query`  a cached read-only tool call (`target` = tool name)
 * - `list`   the catalog of one server: `target` is a {@link CatalogName} (`tools`, `resources`,
 *            `resourceTemplates`, `prompts`). Runs where the catalog is fetched/refreshed (the
 *            result becomes what the synchronous `listTools()`/`listResources()`/... return) and
 *            for `client.discover()`. The "result" is the array of items: filter or annotate it.
 * - `prompt` prompts/get (`target` = prompt name, `args` = its arguments)
 * - `skill`  a skills-extension call; `method` says which (`skills/list`, `skills/get`, `skills/read`)
 * - `event`  an events-extension call; `method` says which (`events/list`: `target` = `events`;
 *            `events/poll`: `target` = the event name, `args` = the subscription arguments, and the
 *            "result" is the poll result `{ events, cursor, truncated, ... }`: filter or redact `events[].data`)
 * - `task`   a tasks-extension call a gateway re-serves (`tasks/get`, `tasks/update`, `tasks/cancel`); `target` is the
 *            name of the tool that started the task, `args` carries the upstream `taskId` (#82)
 * - `extension` any other extension method a gateway passes through on an explicit allowlist; `target` is the method
 */
export type OperationKind = "read" | "call" | "query" | "list" | "prompt" | "skill" | "event" | "task" | "extension";

/** The four catalogs a `list` operation can target. */
export type CatalogName = "tools" | "resources" | "resourceTemplates" | "prompts";

export interface Operation {
  kind: OperationKind;
  peer: string;
  /** Resource URI (read), tool name (call/query), prompt name (prompt), catalog name (list) or skill/file URI (skill). */
  target: string;
  /** The MCP method or client operation, where `kind` alone is ambiguous (`prompts/get`, `tools/list`, `skills/read`, ...). Absent on read/call/query. */
  method?: string;
  /** Tool arguments (call/query) or prompt arguments (prompt); undefined otherwise. Mutable. */
  args?: Record<string, unknown>;
  /** The resolved tool definition (call/query) — read annotations (destructive/read-only) here. */
  def?: Tool;
  /** Per-call context (partition + meta/principal). Mutable. */
  context?: CallContext;
  /** MRTR retry params the caller carried (gateway `interactions: "forward"`); undefined otherwise. */
  interaction?: ToolInteraction;
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
