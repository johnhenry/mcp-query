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

export interface ToolMapShape {
  [name: string]: { args: Record<string, unknown>; result: unknown };
}

export function createTypedHooks<M extends ToolMapShape>() {
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
