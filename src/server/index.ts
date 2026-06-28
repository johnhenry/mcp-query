// Server-side / backend building blocks for mcp-query. Optional, tree-shakeable —
// import from `mcp-query/server`.

export { authorize, denyDestructiveUnless, AuthorizationError } from "./authorize.js";
export type { AuthzVerdict, AuthzRequest } from "./authorize.js";
export { createGateway } from "./gateway.js";
export type { GatewayOptions } from "./gateway.js";
export { circuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
export type { CircuitOptions } from "./circuitBreaker.js";
export { rateLimit } from "./rateLimit.js";
export type { RateLimitOptions } from "./rateLimit.js";
