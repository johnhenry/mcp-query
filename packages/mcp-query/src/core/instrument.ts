// Transport instrumentation — taps every JSON-RPC message in both directions so the
// devtools can show a full message log (the MCP Inspector's defining feature). Wraps
// any SDK Transport transparently via a Proxy, so it survives SDK changes.
//
// v2 caveat: the SDK special-cases its own `StdioClientTransport` (instanceof) for
// the `versionNegotiation: 'auto'` probe — a Proxy-wrapped stdio transport probes
// in place instead of on a disposable sibling process, and probe traffic on the
// sibling path never crosses this tap. See
// https://github.com/johnhenry/mcp-query/issues/16

import type { MessageExtraInfo, Transport } from "@modelcontextprotocol/client";

export type TrafficDirection = "out" | "in";

export interface TrafficEvent {
  dir: TrafficDirection;
  /** A JSON-RPC message (request / response / notification). */
  message: { method?: string; id?: string | number; params?: unknown; result?: unknown; error?: unknown };
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
