// Browser entry (#64): everything a browser host needs from mcp-query in one module, and
// the entry point of the single self-contained bundle (`@johnhenry/mcp-query/bundle`).
// Core client + cache + interceptors, the browser-capable transports (Streamable HTTP, SSE,
// in-memory, the WebSocket bridge) and the gate-style interceptors. No React, no Node-only
// transports (stdio), no peer dependencies.

export * from "./index.js";
export {
  StreamableHTTPClientTransport,
  SSEClientTransport,
  InMemoryTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
export type { Transport, OAuthClientProvider } from "@modelcontextprotocol/client";
export { authorize, denyDestructiveUnless, AuthorizationError, rateLimit, circuitBreaker, CircuitOpenError } from "./server/index.js";
export type { AuthzVerdict, AuthzRequest, AuthorizeOptions, RateLimit, RateLimitOptions, CircuitBreaker, CircuitOptions } from "./server/index.js";
export * from "./bridge/index.js";
