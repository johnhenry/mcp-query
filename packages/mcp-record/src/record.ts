// Recording wrapper — tap a transport (via mcp-query's instrumentTransport seam) and
// pair every outgoing JSON-RPC request with its incoming response into a cassette as
// traffic flows. Drop it in front of any upstream transport; use your app/tests normally.

import type { Transport } from "@modelcontextprotocol/client";
import type { ServerCapabilities } from "@modelcontextprotocol/server";
import { instrumentTransport, type TrafficEvent } from "../../mcp-query/src/core/instrument.js";
import type { Cassette, Interaction } from "./cassette.js";

interface RpcMessage {
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface RecordOptions {
  /**
   * Optional, opt-in redaction applied to each interaction immediately before it's
   * appended to the cassette. This is NOT automatic secret-detection — callers are
   * responsible for identifying and configuring redaction for their own sensitive fields
   * (tokens, PII, etc. passed as tool arguments or returned in tool results; params/results
   * are captured verbatim otherwise). See `redactPaths` for a ready-made path-based rule.
   */
  redact?: (interaction: Interaction) => Interaction;
}

/**
 * Convenience `redact` rule: replaces the value at each dot-path (e.g. "params.apiKey",
 * "result.content.0.text") with `mask` (default `"[REDACTED]"`) on a cloned interaction.
 * Paths that don't resolve on a given interaction are silently skipped. Still opt-in —
 * you must enumerate every field you want redacted.
 */
export function redactPaths(paths: string[], mask: unknown = "[REDACTED]"): (interaction: Interaction) => Interaction {
  return (interaction) => {
    const clone = JSON.parse(JSON.stringify(interaction)) as Record<string, unknown>;
    for (const path of paths) {
      const segs = path.split(".");
      let cursor: unknown = clone;
      for (let i = 0; i < segs.length - 1 && cursor != null && typeof cursor === "object"; i++) {
        cursor = (cursor as Record<string, unknown>)[segs[i]!];
      }
      if (cursor != null && typeof cursor === "object") {
        (cursor as Record<string, unknown>)[segs[segs.length - 1]!] = mask;
      }
    }
    return clone as unknown as Interaction;
  };
}

/**
 * Wrap `inner` so every request/response is appended to `cassette`. Returns the wrapped
 * transport — connect your client to it instead of `inner`. Notifications are ignored;
 * the `initialize` exchange populates the cassette's capabilities/identity.
 */
export function recordTransport(inner: Transport, cassette: Cassette, opts: RecordOptions = {}): Transport {
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
    cassette.interactions.push(opts.redact ? opts.redact(entry) : entry);
  };

  return instrumentTransport(inner, onTraffic);
}
