// Transport instrumentation — taps every JSON-RPC message in both directions so the
// devtools can show a full message log (the MCP Inspector's defining feature). Wraps
// any SDK Transport transparently via a Proxy, so it survives SDK changes.
//
// v2 caveat, re-verified 2026-07-28 against both the pinned stable client and the beta
// this repo originally shipped against (johnhenry/mcp-query#16): the SDK's stdio
// sibling-probe detection is NOT an `instanceof` check — `detectProbeTransportKind`
// is explicitly structural (`"stderr" in transport && "pid" in transport`, its own
// comment: "no instanceof — safe across bundles"), and `readStdioServerParams` reads
// `Object.getPrototypeOf(transport)`, which a `get`/`set`-only Proxy (this file) doesn't
// intercept — `wrapped instanceof StdioClientTransport` is `true`. So an instrumented
// stdio transport does NOT probe in place and does NOT risk the caller's child process;
// the `versionNegotiation: 'auto'` probe still always runs on its own disposable sibling.
// The one real, still-open gap: that sibling is a brand-new, un-instrumented transport,
// so its `server/discover` probe traffic never crosses this tap — connection.ts emits a
// synthetic marker event for it instead of leaving devtools with a silent hole.

import type { MessageExtraInfo, Transport } from "@modelcontextprotocol/client";

export type TrafficDirection = "out" | "in";

export interface TrafficEvent {
  dir: TrafficDirection;
  /** A JSON-RPC message (request / response / notification). */
  message: { method?: string; id?: string | number; params?: unknown; result?: unknown; error?: unknown };
  /**
   * True for a marker event standing in for traffic this tap structurally cannot observe
   * (e.g. the stdio 'auto'-negotiation probe, which runs on a disposable, un-instrumented
   * sibling transport — see the file header). Not a real wire message; devtools should
   * render it as a placeholder, not log it as an actual request/response.
   */
  synthetic?: boolean;
}

export function instrumentTransport(inner: Transport, onTraffic: (e: TrafficEvent) => void): Transport {
  let handler: ((m: unknown, extra?: MessageExtraInfo) => void) | undefined;
  // Tap incoming once; everything the consumer set goes through `handler`.
  // v2's onmessage carries a second arg (authInfo/classification) — forward it,
  // or modern-era inbound classification breaks downstream.
  inner.onmessage = (m, extra) => {
    onTraffic({ dir: "in", message: m as TrafficEvent["message"] });
    handler?.(m, extra);
  };

  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "onmessage") return handler;
      if (prop === "send") {
        return (message: unknown, options?: unknown) => {
          onTraffic({ dir: "out", message: message as TrafficEvent["message"] });
          return (target.send as (m: unknown, o?: unknown) => Promise<void>)(message, options);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
    set(target, prop, value) {
      if (prop === "onmessage") {
        handler = value as typeof handler;
        return true;
      }
      return Reflect.set(target, prop, value, target);
    },
  });
}
