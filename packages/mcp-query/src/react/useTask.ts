// Task hooks (MCP 2025-11-25 call-now/fetch-later). Two shapes:
//   useTask(taskId, { server })  — observe a known task's live status (cache-backed)
//   useToolTask(name, opts)      — useMutation-style: [start, { task, isPending, data, … }]
// Status snapshots come from the same cache entries client.callToolTask maintains, so a
// task started imperatively (or observed via notifications/tasks/status) renders live.

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useMCPClient } from "./provider.js";
import type { CacheKey } from "../core/keys.js";
import type { Task } from "../core/types.js";
import type { MCPError } from "../core/types.js";
import type { TaskCallOpts, TaskHandle } from "../core/client.js";

export interface UseTaskResult {
  /** Latest known status snapshot (undefined until one lands in the cache). */
  task?: Task;
  isRunning: boolean;
  isDone: boolean;
  cancel: () => Promise<void>;
}

const TERMINAL: ReadonlyArray<Task["status"]> = ["completed", "failed", "cancelled"];

/** Observe a task's live status by id. */
export function useTask(taskId: string | undefined, opts: { server: string; partition?: string }): UseTaskResult {
  const client = useMCPClient();
  const key: CacheKey | undefined = taskId
    ? { kind: "task", server: opts.server, taskId, partition: opts.partition }
    : undefined;
  useSyncExternalStore(
    useCallback((cb) => (key ? client.cache.subscribe(key, cb) : () => {}), [client, taskId, opts.server, opts.partition]),
    () => (key ? client.cache.getVersion(key) : 0),
    () => (key ? client.cache.getVersion(key) : 0),
  );
  const task = key ? (client.cache.getSnapshot(key)?.data as Task | undefined) : undefined;
  return {
    task,
    isRunning: !!task && !TERMINAL.includes(task.status),
    isDone: !!task && TERMINAL.includes(task.status),
    cancel: () => (taskId ? client.cancelTask(taskId, opts.server) : Promise.resolve()),
  };
}

export interface UseToolTaskState<R> {
  task?: Task;
  isPending: boolean;
  data?: R;
  error?: MCPError;
  cancel: () => Promise<void>;
}

/** Start task-augmented tool calls, useMutation-style. */
export function useToolTask<A extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
  name: string,
  opts: TaskCallOpts = {},
): [(args: A) => Promise<TaskHandle<R>>, UseToolTaskState<R>] {
  const client = useMCPClient();
  const [taskId, setTaskId] = useState<string | undefined>();
  const [server, setServer] = useState<string>(opts.server ?? "");
  const [data, setData] = useState<R | undefined>();
  const [error, setError] = useState<MCPError | undefined>();
  const handleRef = useRef<TaskHandle<R>>(undefined);

  const view = useTask(taskId, { server, partition: opts.context?.partition });

  const start = useCallback(
    async (args: A) => {
      setData(undefined);
      setError(undefined);
      const handle = await client.callToolTask<A, R>(name, args, opts);
      handleRef.current = handle;
      setServer(handle.server);
      setTaskId(handle.taskId);
      handle
        .result()
        .then((r) => setData(r))
        .catch((e: MCPError) => setError(e));
      return handle;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, name, JSON.stringify(opts)],
  );

  return [
    start,
    {
      task: view.task,
      isPending: !!taskId && view.isRunning,
      data,
      error,
      cancel: () => handleRef.current?.cancel() ?? Promise.resolve(),
    },
  ];
}
