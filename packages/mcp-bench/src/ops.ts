// 2026-07-28 benchmark ops: `server/discover` latency and time-to-terminal for task-returning tools.
//
// A task-returning tool answers `tools/call` with a task handle almost immediately (SEP-2663); the work
// finishes later. Timing only the call therefore measures the handle, not the work. `taskToTerminalOp`
// times the whole thing — call, then poll `tasks/get` until the task is completed, failed or
// cancelled — and also reports the time to the handle as a separate phase.

import type { BenchOp } from "./bench.js";

/** Result an op's `invoke` may return to report extra timings (ms since the invoke started). */
export interface Phased {
  phases: Record<string, number>;
}
export const isPhased = (v: unknown): v is Phased =>
  !!v && typeof v === "object" && typeof (v as Phased).phases === "object" && (v as Phased).phases !== null;

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const TASKS_EXT = "io.modelcontextprotocol/tasks";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const PASS_THROUGH = { "~standard": { version: 1, vendor: "mcp-bench", validate: (value: unknown) => ({ value }) } };

/** The slice of the SDK client the 2026-07-28 ops use (structural, so tests inject fakes). */
export interface RequestClient {
  request(req: { method: string; params?: unknown }, schema: unknown, opts?: unknown): Promise<unknown>;
}
export interface DiscoverClient {
  discover(): Promise<unknown>;
  getProtocolEra?(): string | undefined;
}

export interface TaskOpOptions {
  /** Poll cadence when the server does not suggest one (`pollIntervalMs`). Default 50. */
  pollIntervalMs?: number;
  /** Give up (the call counts as failed) after this long. Default 60_000. */
  timeoutMs?: number;
  /** Injected clock / sleep for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const isHandle = (r: unknown): r is { taskId: string; status?: string; pollIntervalMs?: number } =>
  !!r && typeof r === "object" && typeof (r as { taskId?: unknown }).taskId === "string";

/**
 * Time-to-terminal for a task-returning tool. Each invoke calls the tool declaring the tasks extension;
 * a task handle is then polled with `tasks/get` until terminal. A tool that answers synchronously (no
 * handle) counts as terminal at once. `failed` / `cancelled` tasks and timeouts throw, so they show up
 * in the error rate. Reports a `handle` phase (time to the task handle) next to the total.
 */
export function taskToTerminalOp(client: RequestClient, name: string, args: Record<string, unknown>, opts: TaskOpOptions = {}): BenchOp {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const meta = { [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXT]: {} } } };
  return {
    label: `task:${name}`,
    invoke: async (): Promise<Phased> => {
      const t0 = now();
      const created = await client.request({ method: "tools/call", params: { name, arguments: args, _meta: meta } }, PASS_THROUGH);
      const handleMs = now() - t0;
      if (!isHandle(created)) return { phases: { handle: handleMs } }; // synchronous answer: handle == terminal
      let status = created.status;
      let wait = created.pollIntervalMs ?? opts.pollIntervalMs ?? 50;
      while (!status || !TERMINAL.has(status)) {
        if (now() - t0 > timeoutMs) throw new Error(`task ${created.taskId} for "${name}" did not finish within ${timeoutMs}ms (last status: ${status ?? "unknown"})`);
        await sleep(Math.max(1, wait));
        const snap = (await client.request({ method: "tasks/get", params: { taskId: created.taskId, _meta: meta } }, PASS_THROUGH)) as { status?: string; pollIntervalMs?: number };
        status = snap.status;
        wait = snap.pollIntervalMs ?? wait;
      }
      if (status !== "completed") throw new Error(`task ${created.taskId} for "${name}" ended ${status}`);
      return { phases: { handle: handleMs } };
    },
  };
}

/** `server/discover` latency (2026-07-28 connections only; a legacy connection has no such request). */
export function discoverOp(client: DiscoverClient): BenchOp {
  return {
    label: "server/discover",
    invoke: async () => {
      if (client.getProtocolEra?.() === "legacy") throw new Error("server/discover needs a 2026-07-28 connection; this one negotiated the legacy initialize handshake");
      return client.discover();
    },
  };
}
