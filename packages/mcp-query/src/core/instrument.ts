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
//
// Issue #18: the Proxy-wrapping logic itself is now @johnhenry/agent-query-core's
// instrumentTransport (byte-identical, just generalized to a structural TransportLike
// instead of importing the SDK's own Transport type). mcp-query's `synthetic?: boolean`
// (added for the #16 stdio-probe-visibility fix, consumed by connection.ts's direct
// synthetic-marker `onTraffic` calls — core has no reason to know about it) stays as a
// local overlay on TrafficEvent rather than being upstreamed in this pass.

import { instrumentTransport as coreInstrumentTransport, type TrafficEvent as CoreTrafficEvent, type TransportLike } from "@johnhenry/agent-query-core";
import type { Transport } from "@modelcontextprotocol/client";

export type TrafficDirection = "out" | "in";

export interface TrafficEvent extends CoreTrafficEvent {
  /**
   * True for a marker event standing in for traffic this tap structurally cannot observe
   * (e.g. the stdio 'auto'-negotiation probe, which runs on a disposable, un-instrumented
   * sibling transport — see the file header). Not a real wire message; devtools should
   * render it as a placeholder, not log it as an actual request/response.
   */
  synthetic?: boolean;
}

export function instrumentTransport(inner: Transport, onTraffic: (e: TrafficEvent) => void): Transport {
  // Transport's onmessage is generically typed (<T extends JSONRPCMessage>), which doesn't
  // structurally satisfy TransportLike's `(message: unknown, extra?: unknown) => void` in
  // TS's eyes even though the runtime shape is exactly what core's Proxy wrapper needs
  // (it never inspects the message type, only forwards it) — an intentional boundary cast.
  return coreInstrumentTransport(inner as unknown as TransportLike, onTraffic) as unknown as Transport;
}
