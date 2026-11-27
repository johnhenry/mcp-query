// The `io.modelcontextprotocol/tasks` extension (SEP-2663) — mcp-query-defined
// wire schemas. The 2026-07-28 spec moved tasks out of the core protocol into
// this official extension and redesigned the flow: polling `tasks/get` replaces
// the blocking `tasks/result`, `tasks/list` is gone, and the new `tasks/update`
// carries client→server input for `input_required` tasks. Task creation is
// server-directed: a `tools/call` MAY be answered with a `CreateTaskResult`
// (`resultType: "task"`) instead of a plain result — there is no per-request
// opt-in parameter anymore.
//
// The v2 SDK ships NO runtime for this extension, so mcp-query drives these
// schemas over `client.request(…, schema)`. SDK 2.0.0 era-gates tasks/get and
// tasks/cancel off the 2026-07-28 wire; SDK >= 2.3.0 lets them through (see
// tasksProbe.ts for the runtime check). Tracking:
// https://github.com/johnhenry/mcp-query/issues/12
//
// Field names verified 2026-11-26 against the ext-tasks v2 schema
// (modelcontextprotocol/ext-tasks, packages/ext-tasks/schema/v2/schema.ts):
// `ttlMs`, `pollIntervalMs`, `inputRequests`, `inputResponses`, `notifications/tasks`.
// Status pushes over the modern era need a `taskIds` filter on
// `subscriptions/listen` that the SDK client does not expose, so modern-era
// status is poll-only.

import * as z from "zod";

/** Extension identifier, as it appears under `capabilities.extensions`. */
export const TASKS_EXT = "io.modelcontextprotocol/tasks";

export const TaskStatusSchema = z.enum(["working", "input_required", "completed", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const taskBase = {
  taskId: z.string(),
  status: TaskStatusSchema,
  statusMessage: z.string().optional(),
  /** ISO 8601 timestamps. */
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  /** How long (ms) the server retains the task after terminal status; null = unbounded. */
  ttlMs: z.number().int().nullable(),
  /** Server's suggested polling cadence (ms) for tasks/get. */
  pollIntervalMs: z.number().int().optional(),
};

/** A task snapshot as carried on `CreateTaskResult` and `tasks/get`. */
export const TaskSchema = z.looseObject(taskBase);
export type Task = z.infer<typeof TaskSchema>;

/**
 * The status-discriminated detail shape returned by `tasks/get` and pushed on
 * `notifications/tasks`: `input_required` adds the pending `inputRequests` map,
 * `completed` inlines the tool result, `failed` carries the error.
 */
export const DetailedTaskSchema = z.discriminatedUnion("status", [
  z.looseObject({ ...taskBase, status: z.literal("working") }),
  z.looseObject({
    ...taskBase,
    status: z.literal("input_required"),
    /** Same request objects the MRTR pattern embeds (elicitation/sampling/roots). */
    inputRequests: z.record(z.string(), z.looseObject({ method: z.string(), params: z.unknown() })).optional(),
  }),
  z.looseObject({ ...taskBase, status: z.literal("completed"), result: z.record(z.string(), z.unknown()).optional() }),
  z.looseObject({ ...taskBase, status: z.literal("failed"), error: z.record(z.string(), z.unknown()).optional() }),
  z.looseObject({ ...taskBase, status: z.literal("cancelled") }),
]);
export type DetailedTask = z.infer<typeof DetailedTaskSchema>;

/** `tasks/get` result. */
export const GetTaskResultSchema = DetailedTaskSchema;
/** `tasks/update` and `tasks/cancel` acks (empty results; loose for _meta/resultType). */
export const UpdateTaskResultSchema = z.looseObject({});
export const CancelTaskResultSchema = z.looseObject({});

/** Params for `notifications/tasks` (unsolicited task status push): a full DetailedTask. */
export const TaskNotificationParamsSchema = DetailedTaskSchema;

/**
 * A `tools/call` result under the extension: either a `CreateTaskResult`
 * (task-shaped — discriminate on `taskId` presence, since the 2025-era codec
 * strips the wire-only `resultType` before the schema sees it) or the plain
 * tool result.
 */
export const CallToolOrTaskResultSchema = z.union([
  TaskSchema,
  z.looseObject({
    content: z.array(z.unknown()).default([]),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
]);
export type CallToolOrTaskResult = z.infer<typeof CallToolOrTaskResultSchema>;

/** True when a tools/call result is a task handle rather than a plain result. */
export function isTaskShaped(result: unknown): result is Task {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as { taskId?: unknown }).taskId === "string" &&
    typeof (result as { status?: unknown }).status === "string"
  );
}

/** Terminal statuses — polling stops and handles settle. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];
