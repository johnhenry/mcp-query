// Capability probe: will the installed @modelcontextprotocol/client put the
// `events/*` extension methods on a 2026-07-28 wire?
//
// The SDK era-gates the methods IT defines (tasks/* on SDK 2.0.0, see
// tasksProbe.ts) and leaves methods outside its spec universe "consumer-owned" and
// era-blind. `events/*` is not in the 2.0.0 registry, so it passes; a later SDK that
// registers `events/*` for one era only would block it. The peer range is ^2.0.0, so
// we probe behaviour instead of comparing versions (no package.json read; browser-safe).
//
// The probe sends `events/list` with an ALREADY-ABORTED signal: the SDK runs its era
// gate first and checks the signal before anything reaches the transport, so the
// probe never touches the wire.

import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { ListEventsResultSchema } from "./eventsExt.js";

interface RequestCapable {
  request(req: { method: string; params?: unknown }, schema: unknown, opts?: unknown): Promise<unknown>;
}

const cache = new WeakMap<object, Promise<boolean>>();

/** True when `sdk` (a connected client on a modern-era connection) can send `events/*`. Cached per client. */
export function sdkSupportsEventMethods(sdk: RequestCapable): Promise<boolean> {
  let p = cache.get(sdk);
  if (!p) {
    p = (async () => {
      const ac = new AbortController();
      ac.abort(new Error("mcp-query events capability probe"));
      try {
        await sdk.request({ method: "events/list", params: {} }, ListEventsResultSchema, { signal: ac.signal });
        return true;
      } catch (err) {
        return !(err instanceof SdkError && err.code === SdkErrorCode.MethodNotSupportedByProtocolVersion);
      }
    })();
    cache.set(sdk, p);
  }
  return p;
}
