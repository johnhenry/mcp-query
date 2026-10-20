// WebSocket <-> MCP bridge: wire protocol + the browser CORS contract (#63).
//
// A browser cannot spawn a stdio MCP server, so a small local process (the "bridge")
// accepts a WebSocket from the page, dials the real server (stdio / Streamable HTTP / SSE)
// and relays JSON-RPC frames both ways. This module is the shared, dependency-free
// definition; `WebSocketBridgeTransport` (./client.ts) is the browser side and
// `startBridge` (./server.ts) is a Node reference implementation. Any other implementation
// (a Rust/Go companion, a Worker) interoperates by speaking these frames.
//
// Connect: `ws://<host>:<port>/?token=<bearer>`; the bridge closes with code 1008
// ("policy violation") on a wrong token or a disallowed Origin.
//
// Text frames, one JSON object each.
//   client -> bridge
//     { "control": { "connect": TargetSpec } }   dial the target (first frame; once)
//     { "msg": <JSON-RPC message> }              forward to the target
//     { "control": { "close": true } }           close the target
//   bridge -> client
//     { "control": { "connected": true } }       target is up (answer to connect)
//     { "control": { "failed": true }, "error": "..." }   dial failed; socket then closes
//     { "msg": <JSON-RPC message> }              a message from the target
//     { "error": "..." }                         a non-fatal transport error
//     { "control": { "closed": true } }          the target closed; socket then closes

/** How the client declares the server for the bridge to dial. */
export interface TargetSpec {
  transport: "stdio" | "http" | "sse";
  /** stdio: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http / sse: server URL. */
  url?: string;
  /** Hint for apps: connect http/sse directly from the browser (so OAuth runs there) instead of through the bridge. */
  direct?: boolean;
}

export type ClientFrame =
  | { control: { connect: TargetSpec } }
  | { control: { close: true } }
  | { msg: unknown };

export type BridgeFrame =
  | { control: { connected: true } }
  | { control: { failed: true }; error?: string }
  | { control: { closed: true } }
  | { msg: unknown }
  | { error: string };

/** Request headers a browser MCP client sends to a Streamable HTTP server (preflight must allow them). */
export const MCP_CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Last-Event-ID",
] as const;

/** Response headers a browser client must be able to read (`Mcp-Session-Id` arrives on initialize). */
export const MCP_CORS_EXPOSE_HEADERS = ["Mcp-Session-Id", "Mcp-Protocol-Version"] as const;

/**
 * CORS response headers for a Streamable HTTP MCP endpoint, for one allowed origin. Send
 * them on every response and answer `OPTIONS` preflights with `204` plus the same set. Pass
 * the request's `Origin` only after checking it against your allowlist; never echo
 * arbitrary origins on an endpoint that accepts credentials.
 */
export function mcpCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": MCP_CORS_ALLOW_HEADERS.join(", "),
    "Access-Control-Expose-Headers": MCP_CORS_EXPOSE_HEADERS.join(", "),
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
