// Typed hook factory — closes the codegen loop. Feed it the `GeneratedToolMap` emitted
// by `mcp-query/codegen` and get useTool/useToolResult variants keyed by tool name, with
// fully-typed args and results.
//
//   import type { GeneratedToolMap } from "./mcp.gen";
//   const { useTool, useToolResult } = createTypedHooks<GeneratedToolMap>();
//   const [createIssue] = useTool("github.create_issue"); // args typed from the schema

import { useTool as useToolBase } from "./useTool.js";
import { useToolResult as useToolResultBase, type UseToolResultOptions } from "./useToolResult.js";
import type { CallToolOpts } from "../core/client.js";

/**
 * Constraint for a generated tool map. Mapped over M's own keys (rather than demanding a
 * string index signature) so codegen's plain `interface GeneratedToolMap` satisfies it —
 * an interface has no implicit index signature, which made the documented pairing above
 * fail to compile before.
 */
export type ToolMapShape<M = Record<string, { args: Record<string, unknown>; result: unknown }>> = {
  [K in keyof M]: { args: Record<string, unknown>; result: unknown };
};

export function createTypedHooks<M extends ToolMapShape<M>>() {
  return {
    useTool: <K extends keyof M & string>(name: K, opts?: Omit<CallToolOpts<M[K]["args"], M[K]["result"]>, "signal">) =>
      useToolBase<M[K]["args"], M[K]["result"]>(name, opts),
    useToolResult: <K extends keyof M & string>(
      name: K,
      args: M[K]["args"],
      opts?: UseToolResultOptions<M[K]["args"], M[K]["result"]>,
    ) => useToolResultBase<M[K]["args"], M[K]["result"]>(name, args, opts),
  };
}
