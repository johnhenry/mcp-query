// Capability probe: can the installed @modelcontextprotocol/client send the
// tasks-extension RPCs (tasks/get, tasks/cancel) on a 2026-07-28 connection?
//
// SDK 2.0.0 era-gates `tasks/*` off the modern wire (SdkError
// METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION, thrown locally before anything is
// sent). SDK >= 2.3.0 lets `tasks/get` / `tasks/cancel` through (SEP-2663 reuses
// those names) and treats `tasks/update` as a consumer-owned extension method.
// The peer range is ^2.0.0, so we probe behaviour instead of comparing versions
// (no package.json read; stays browser-safe).
//
// The probe sends a `tasks/get` with an ALREADY-ABORTED signal: the SDK runs its
// era gate first and checks the signal before anything reaches the transport, so
// the probe never touches the wire.

import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { GetTaskResultSchema } from "./tasksExt.js";

interface RequestCapable {
  request(req: { method: string; params?: unknown }, schema: unknown, opts?: unknown): Promise<unknown>;
}

const cache = new WeakMap<object, Promise<boolean>>();

/** True when `sdk` (a connected client on a modern-era connection) can send tasks/get. Cached per client. */
export function sdkSupportsModernTasks(sdk: RequestCapable): Promise<boolean> {
  let p = cache.get(sdk);
  if (!p) {
    p = (async () => {
      const ac = new AbortController();
      ac.abort(new Error("mcp-query tasks capability probe"));
      try {
        await sdk.request({ method: "tasks/get", params: { taskId: "mcp-query-probe" } }, GetTaskResultSchema, {
          signal: ac.signal,
        });
        return true;
      } catch (err) {
        return !(err instanceof SdkError && err.code === SdkErrorCode.MethodNotSupportedByProtocolVersion);
      }
    })();
    cache.set(sdk, p);
  }
  return p;
}
