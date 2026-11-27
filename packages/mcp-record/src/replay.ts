// Replay — serve a recorded cassette as a real (offline, deterministic) MCP server.
// Each request is matched to its recorded interaction by method + canonical params and
// the *actual recorded result* is returned. Repeated identical calls replay in recorded
// order (stateful episodes), the last one sticking. A request with no exact match throws —
// replay never guesses by falling back to some other params/tool recorded under the same
// JSON-RPC method (see SEC-audit finding: silent method-only fallback returned stale/wrong
// data for any params mismatch, including entirely unrelated tools sharing "tools/call").
//
// Format 2 adds the 2026-07-28 surface:
//  - multi round-trip requests: the retry's `inputResponses` / `requestState` are part of the match
//    key, so round 0 (the `input_required` result) and round N (the final result) are different
//    interactions even though they share a tool name and arguments. SDK servers lift those two
//    fields out of `params`, so they are read back from the request context.
//  - task sequences: `tasks/get` polling replays the recorded statuses in order (the terminal one
//    sticks), and `tasks/update` / `tasks/cancel` replay by their own params.
//  - `skills/*` calls replay like any other method.
//  - a modern-era cassette is served through the SDK's era-aware HTTP handler, so a modern client
//    negotiates with `server/discover` and never sees `initialize`.

import { createMcpHandler, Server, InMemoryTransport, type ServerCapabilities } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import * as z from "zod";
import { interactionKey, upgradeCassette, type Cassette, type CassetteV1 } from "./cassette.js";

export interface ReplayOptions {
  /**
   * Opt-in loose matching for a multi round-trip retry: when no interaction matches the exact
   * `inputResponses`, fall back to one recorded with the same method, params and `requestState`
   * but different answers (replaying a flow with other user input). Off by default: replay is exact.
   */
  looseInputResponses?: boolean;
}

/** Methods the SDK types natively (2-arg `setRequestHandler`). Everything else goes through the loose 3-arg form. */
const TYPED = new Set([
  "tools/list", "tools/call", "resources/list", "resources/read", "resources/templates/list",
  "prompts/list", "prompts/get", "completion/complete",
]);
/** Methods that need a capability on the server before the SDK lets a handler register. */
const CAPABILITY_FOR: Record<string, (c: ServerCapabilities) => boolean> = {
  "tools/list": (c) => !!c.tools,
  "tools/call": (c) => !!c.tools,
  "resources/list": (c) => !!c.resources,
  "resources/read": (c) => !!c.resources,
  "resources/templates/list": (c) => !!c.resources,
  "prompts/list": (c) => !!c.prompts,
  "prompts/get": (c) => !!c.prompts,
  "completion/complete": (c) => !!c.completions,
};
const EXTENSION_METHODS = ["tasks/get", "tasks/update", "tasks/cancel", "skills/list", "skills/get"] as const;

type Ctx = { mcpReq?: { inputResponses?: Record<string, unknown>; requestState?: unknown } } | undefined;

/** Restore the MRTR fields the SDK lifts out of `params`, so retries key differently from round 0. */
function effectiveParams(params: unknown, ctx: Ctx): unknown {
  const base = params && typeof params === "object" ? { ...(params as Record<string, unknown>) } : {};
  const responses = ctx?.mcpReq?.inputResponses;
  if (base.inputResponses === undefined && responses && Object.keys(responses).length) base.inputResponses = responses;
  if (base.requestState === undefined) {
    const rs = ctx?.mcpReq?.requestState;
    const state = typeof rs === "function" ? (rs as () => unknown)() : rs;
    if (typeof state === "string") base.requestState = state;
  }
  return base;
}

function withoutResponses(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const { inputResponses: _r, ...rest } = params as Record<string, unknown>;
  void _r;
  return rest;
}

type ReplayState = { lookup: (method: string, params: unknown) => unknown; countByMethod: Map<string, number> };

/** The per-connection replay cursor: queues of recorded results, consumed in order. */
function createReplayState(cassette: Cassette, opts: ReplayOptions): ReplayState {
  // Index interactions into per-key queues so identical calls replay in order.
  const queues = new Map<string, Array<{ result: unknown; error?: { code?: number; message?: string } }>>();
  const loose = new Map<string, Array<{ result: unknown; error?: { code?: number; message?: string } }>>();
  const countByMethod = new Map<string, number>();
  for (const it of cassette.interactions) {
    const key = interactionKey(it.method, it.params);
    const q = queues.get(key) ?? [];
    q.push({ result: it.result, error: it.error });
    queues.set(key, q);
    if (opts.looseInputResponses) {
      const lk = interactionKey(it.method, withoutResponses(it.params));
      const lq = loose.get(lk) ?? [];
      lq.push({ result: it.result, error: it.error });
      loose.set(lk, lq);
    }
    countByMethod.set(it.method, (countByMethod.get(it.method) ?? 0) + 1);
  }
  const take = <T>(q: T[]): T => (q.length > 1 ? q.shift()! : q[0]!);

  // Deliberately NO method-only fallback here: returning "some other recording of this
  // method" (e.g. a different tool's `tools/call`, or the same tool with different params)
  // is silent data corruption, not a convenience. Loose matching exists only as the explicit
  // `looseInputResponses` opt-in above.
  const lookup = (method: string, params: unknown): unknown => {
    let q = queues.get(interactionKey(method, params));
    if (!q?.length && opts.looseInputResponses) q = loose.get(interactionKey(method, withoutResponses(params)));
    if (q && q.length) {
      const hit = take(q);
      if (hit.error) throw Object.assign(new Error(hit.error.message ?? "recorded error"), { code: hit.error.code });
      return hit.result;
    }
    const n = countByMethod.get(method) ?? 0;
    throw new Error(
      n > 0
        ? `mcp-record: no recorded interaction matches this request — recorded ${n} interaction${n === 1 ? "" : "s"} for method "${method}", none match these params`
        : `mcp-record: no recorded interaction for method "${method}"`,
    );
  };

  return { lookup, countByMethod };
}

/** Build an SDK Server that replays the cassette. Connect it to any server transport. */
export function replayServer(input: Cassette | CassetteV1, opts: ReplayOptions = {}): Server {
  const cassette = upgradeCassette(input);
  return buildReplayServer(cassette, createReplayState(cassette, opts));
}

function buildReplayServer(cassette: Cassette, state: ReplayState): Server {
  const caps: ServerCapabilities = cassette.capabilities ?? {};
  const { lookup, countByMethod } = state;
  const server = new Server(
    { name: cassette.recordedFrom?.name ?? "mcp-record-replay", version: cassette.recordedFrom?.version ?? "0.0.1" },
    { capabilities: caps },
  );

  for (const method of Object.keys(CAPABILITY_FOR)) {
    if (!CAPABILITY_FOR[method]!(caps)) continue;
    (server as unknown as { setRequestHandler(m: string, h: (req: { params?: unknown }, ctx: Ctx) => unknown): void }).setRequestHandler(
      method,
      (req, ctx) => lookup(method, effectiveParams(req.params, ctx)) as never,
    );
  }
  // Extension methods outside the SDK's typed surface: register only what the recording used.
  for (const method of EXTENSION_METHODS) {
    if (!countByMethod.has(method) || TYPED.has(method)) continue;
    (server as unknown as { setRequestHandler(m: string, schemas: unknown, h: (params: unknown, ctx: Ctx) => unknown): void }).setRequestHandler(
      method,
      { params: z.looseObject({}) },
      (params, ctx) => lookup(method, effectiveParams(params, ctx)) as never,
    );
  }
  return server;
}

/**
 * A ConnectionConfig-style transport factory backed by the cassette: each call links a
 * fresh replay server. Use directly as an mcp-query upstream `transport`, or to drive an SDK
 * Client in tests — no subprocess, no network. A cassette recorded on a 2026-07-28 connection
 * (`protocol.era === "modern"`) is served through the era-aware HTTP handler (in-process, no
 * socket) so modern clients negotiate with `server/discover`; anything else is served over an
 * in-memory pair with the classic `initialize` handshake.
 */
export function replayTransport(input: Cassette | CassetteV1, opts: ReplayOptions = {}): () => Transport {
  const cassette = upgradeCassette(input);
  if (cassette.protocol?.era === "modern") {
    return () => {
      // The handler builds a server per HTTP request, so the replay cursor must live outside it:
      // otherwise every `tasks/get` poll would restart from the first recorded status.
      const state = createReplayState(cassette, opts);
      const handler = createMcpHandler(() => buildReplayServer(cassette, state), { legacy: "reject" });
      return new StreamableHTTPClientTransport(new URL("http://replay.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      });
    };
  }
  return () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    void replayServer(cassette, opts).connect(serverT);
    return clientT;
  };
}
