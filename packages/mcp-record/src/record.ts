// Recording wrapper — tap a transport (via mcp-query's instrumentTransport seam) and
// pair every outgoing JSON-RPC request with its incoming response into a cassette as
// traffic flows. Drop it in front of any upstream transport; use your app/tests normally.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { instrumentTransport, type TrafficEvent } from "../../mcp-query/src/core/instrument.js";
import type { Cassette, Interaction } from "./cassette.js";

interface RpcMessage {
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Wrap `inner` so every request/response is appended to `cassette`. Returns the wrapped
 * transport — connect your client to it instead of `inner`. Notifications are ignored;
 * the `initialize` exchange populates the cassette's capabilities/identity.
 */
export function recordTransport(inner: Transport, cassette: Cassette): Transport {
  const pending = new Map<string | number, { method: string; params: unknown }>();

  const onTraffic = (e: TrafficEvent): void => {
    const m = e.message as RpcMessage;
    if (e.dir === "out") {
      // A request carries both a method and an id. (Notifications have no id → skip.)
      if (m.method && m.id !== undefined) pending.set(m.id, { method: m.method, params: m.params });
      return;
    }
    // incoming: match a response to its pending request by id.
    if (m.id === undefined) return; // server-initiated notification → skip
    const req = pending.get(m.id);
    if (!req) return;
    pending.delete(m.id);

    if (req.method === "initialize" && m.result && typeof m.result === "object") {
      const r = m.result as { protocolVersion?: string; capabilities?: ServerCapabilities; serverInfo?: { name?: string; version?: string } };
      cassette.protocolVersion = r.protocolVersion;
      cassette.capabilities = r.capabilities;
      cassette.recordedFrom = r.serverInfo;
      return; // initialize is replayed by the Server constructor, not from interactions
    }

    const entry: Interaction = { method: req.method, params: req.params };
    if (m.error) entry.error = { code: m.error.code, message: m.error.message };
    else entry.result = m.result;
    cassette.interactions.push(entry);
  };

  return instrumentTransport(inner, onTraffic);
}
