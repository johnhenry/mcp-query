// Transport instrumentation — taps every JSON-RPC message in both directions so the
// devtools can show a full message log (the MCP Inspector's defining feature). Wraps
// any SDK Transport transparently via a Proxy, so it survives SDK changes.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type TrafficDirection = "out" | "in";

export interface TrafficEvent {
  dir: TrafficDirection;
  /** A JSON-RPC message (request / response / notification). */
  message: { method?: string; id?: string | number; params?: unknown; result?: unknown; error?: unknown };
}

export function instrumentTransport(inner: Transport, onTraffic: (e: TrafficEvent) => void): Transport {
  let handler: ((m: unknown) => void) | undefined;
  // Tap incoming once; everything the consumer set goes through `handler`.
  inner.onmessage = (m) => {
    onTraffic({ dir: "in", message: m as TrafficEvent["message"] });
    handler?.(m);
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
