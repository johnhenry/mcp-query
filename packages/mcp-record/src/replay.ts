// Replay — serve a recorded cassette as a real (offline, deterministic) MCP server.
// Each request is matched to its recorded interaction by method + canonical params and
// the *actual recorded result* is returned. Repeated identical calls replay in recorded
// order (stateful episodes), the last one sticking.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
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
  const firstByMethod = new Map<string, unknown>();
  for (const it of cassette.interactions) {
    const key = interactionKey(it.method, it.params);
    const q = queues.get(key) ?? [];
    q.push(it.result);
    queues.set(key, q);
    if (!firstByMethod.has(it.method)) firstByMethod.set(it.method, it.result);
  }

  const lookup = (method: string, params: unknown): unknown => {
    const q = queues.get(interactionKey(method, params));
    if (q && q.length) return q.length > 1 ? q.shift() : q[0];
    // Fall back to any recording of this method (e.g. a list whose cursor we didn't record).
    if (firstByMethod.has(method)) return firstByMethod.get(method);
    throw new Error(`mcp-record: no recorded ${method} for the given params`);
  };
  const handle = (method: string) => (req: { params?: unknown }) => lookup(method, req.params) as never;

  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, handle("tools/list"));
    server.setRequestHandler(CallToolRequestSchema, handle("tools/call"));
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, handle("resources/list"));
    server.setRequestHandler(ReadResourceRequestSchema, handle("resources/read"));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, handle("resources/templates/list"));
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, handle("prompts/list"));
    server.setRequestHandler(GetPromptRequestSchema, handle("prompts/get"));
  }
  if (caps.completions) {
    server.setRequestHandler(CompleteRequestSchema, handle("completion/complete"));
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
