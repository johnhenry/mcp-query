// Gateway-side routing-header validation (SEP-2243). The SDK's HTTP entry already rejects a
// disagreeing `Mcp-Method` and an `Mcp-Name` for `tools/call`, `prompts/get` and `resources/read`
// on a 2026-07-28 request, but not `Mcp-Param-*` (its check lives on the high-level `McpServer`; the
// gateway is a low-level `Server`), not the `Mcp-Name` of the `tasks/*` (SEP-2663) and `events/*`
// (SEP-3415) methods the gateway passes through, and nothing on a 2025-era request. This guard
// fronts `handler.fetch` and rejects every disagreement with HTTP 400 + `HeaderMismatch` (-32020),
// the way the spec requires, before any handler or upstream sees the request.
//
// It only ever COMPARES: the values policy, rate limits and audit see (`CallContext.routing`) are
// derived from the body by the handlers, never copied from a header.

import { checkRoutingHeaders, HEADER_MISMATCH } from "../core/routingHeaders.js";

/** Largest request body the guard will read; a bigger one is left to the SDK's own handling. */
const MAX_BODY = 4 * 1024 * 1024;
const FIRST_MODERN = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

export interface RoutingGuardOptions {
  /** The `inputSchema` of the tool a `tools/call` names (the gateway-facing, possibly namespaced name); undefined when unknown. */
  toolSchema?: (name: string) => unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Is any routing header on the request? (A request that carries none and is not modern needs no check.) */
function hasRoutingHeader(req: Request): boolean {
  let any = false;
  req.headers.forEach((_v, k) => {
    const key = k.toLowerCase();
    if (key === "mcp-method" || key === "mcp-name" || key.startsWith("mcp-param-")) any = true;
  });
  return any;
}

/**
 * Wrap a fetch-style handler so a request whose routing headers disagree with its JSON-RPC body is
 * answered `400` + `-32020` instead of being dispatched.
 */
export function withRoutingGuard<O>(
  fetchFn: (req: Request, opts?: O) => Promise<Response>,
  guard: RoutingGuardOptions = {},
): (req: Request, opts?: O) => Promise<Response> {
  return async (req, opts) => {
    if (req.method !== "POST") return fetchFn(req, opts);
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) return fetchFn(req, opts);
    let body: unknown;
    try {
      const text = await req.clone().text();
      if (text.length > MAX_BODY) return fetchFn(req, opts);
      body = JSON.parse(text);
    } catch {
      return fetchFn(req, opts); // not JSON: the SDK reports that its own way
    }
    // Requests only (id present); notifications have no required headers in this revision. Batches are not valid here.
    if (!isRecord(body) || typeof body.method !== "string" || body.id === undefined || body.id === null) return fetchFn(req, opts);
    const params = isRecord(body.params) ? body.params : undefined;
    const version = isRecord(params?._meta) ? params._meta[VERSION_KEY] : undefined;
    const modern = typeof version === "string" && version >= FIRST_MODERN;
    if (!modern && !hasRoutingHeader(req)) return fetchFn(req, opts);

    const inputSchema = body.method === "tools/call" && typeof params?.name === "string" ? guard.toolSchema?.(params.name) : undefined;
    const mismatch = checkRoutingHeaders({
      headers: req.headers,
      body: { method: body.method, ...(params ? { params } : {}) },
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      modern,
    });
    if (mismatch === undefined) return fetchFn(req, opts);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: HEADER_MISMATCH, message: `Bad Request: the request headers and body disagree: ${mismatch}` } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  };
}
