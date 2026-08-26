// Replay — serve a recorded cassette as a real (offline, deterministic) MCP server.
// Each request is matched to its recorded interaction by method + canonical params and
// the *actual recorded result* is returned. Repeated identical calls replay in recorded
// order (stateful episodes), the last one sticking. A request with no exact match throws —
// replay never guesses by falling back to some other params/tool recorded under the same
// JSON-RPC method (see SEC-audit finding: silent method-only fallback returned stale/wrong
// data for any params mismatch, including entirely unrelated tools sharing "tools/call").

import { Server, InMemoryTransport, type ServerCapabilities } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/client";
import { interactionKey, type Cassette } from "./cassette.js";

/** Build an SDK Server that replays the cassette. Connect it to any server transport. */
export function replayServer(cassette: Cassette): Server {
  const caps: ServerCapabilities = cassette.capabilities ?? {};
  const server = new Server(
    { name: cassette.recordedFrom?.name ?? "mcp-record-replay", version: cassette.recordedFrom?.version ?? "0.0.1" },
    { capabilities: caps },
  );

  // Index interactions into per-key queues so identical calls replay in order.
  const queues = new Map<string, unknown[]>();
  const countByMethod = new Map<string, number>();
  for (const it of cassette.interactions) {
    const key = interactionKey(it.method, it.params);
    const q = queues.get(key) ?? [];
    q.push(it.result);
    queues.set(key, q);
    countByMethod.set(it.method, (countByMethod.get(it.method) ?? 0) + 1);
  }

  // Deliberately NO method-only fallback here: returning "some other recording of this
  // method" (e.g. a different tool's `tools/call`, or the same tool with different params)
  // is silent data corruption, not a convenience. If callers genuinely want loose matching
  // for something like an unrecorded pagination cursor, that must be its own explicit,
  // opt-in feature — not the default.
  const lookup = (method: string, params: unknown): unknown => {
    const q = queues.get(interactionKey(method, params));
    if (q && q.length) return q.length > 1 ? q.shift() : q[0];
    const n = countByMethod.get(method) ?? 0;
    throw new Error(
      n > 0
        ? `mcp-record: no recorded interaction matches this request — recorded ${n} interaction${n === 1 ? "" : "s"} for method "${method}", none match these params`
        : `mcp-record: no recorded interaction for method "${method}"`,
    );
  };
  const handle = (method: string) => (req: { params?: unknown }) => lookup(method, req.params) as never;

  if (caps.tools) {
    server.setRequestHandler("tools/list", handle("tools/list"));
    server.setRequestHandler("tools/call", handle("tools/call"));
  }
  if (caps.resources) {
    server.setRequestHandler("resources/list", handle("resources/list"));
    server.setRequestHandler("resources/read", handle("resources/read"));
    server.setRequestHandler("resources/templates/list", handle("resources/templates/list"));
  }
  if (caps.prompts) {
    server.setRequestHandler("prompts/list", handle("prompts/list"));
    server.setRequestHandler("prompts/get", handle("prompts/get"));
  }
  if (caps.completions) {
    server.setRequestHandler("completion/complete", handle("completion/complete"));
  }
  return server;
}

/**
 * A ConnectionConfig-style transport factory backed by the cassette: each call links a
 * fresh replay server over an in-memory pair. Use directly as an mcp-query upstream
 * `transport`, or to drive an SDK Client in tests — no subprocess, no network.
 */
export function replayTransport(cassette: Cassette): () => Transport {
  return () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    void replayServer(cassette).connect(serverT);
    return clientT;
  };
}
