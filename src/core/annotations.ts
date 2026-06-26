// Helpers for the MCP metadata a non-agentic client cares about: tool behavior hints
// (read-only/destructive/idempotent — they drive cache/retry/confirm policy), content
// annotations (audience/priority), and structured tool output.

import type { Tool } from "./types.js";

export const isReadOnly = (t?: Tool): boolean => t?.annotations?.readOnlyHint === true;
export const isDestructive = (t?: Tool): boolean => t?.annotations?.destructiveHint === true;
export const isIdempotent = (t?: Tool): boolean => t?.annotations?.idempotentHint === true;

/** A content block's intended audience (["user"], ["assistant"], …) and priority, if annotated. */
export function contentAnnotations(content: unknown): { audience?: string[]; priority?: number } {
  const a = (content as { annotations?: { audience?: string[]; priority?: number } })?.annotations;
  return { audience: a?.audience, priority: a?.priority };
}

/** Structured tool output (the `structuredContent` field), if the server returned any. */
export function structuredContent<T = unknown>(result: unknown): T | undefined {
  return (result as { structuredContent?: T })?.structuredContent;
}

/** Whether a tool result signaled a tool-level error (the `isError` channel). */
export function isToolError(result: unknown): boolean {
  return (result as { isError?: boolean })?.isError === true;
}
