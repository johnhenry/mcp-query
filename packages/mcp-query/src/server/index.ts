// Server-side / backend building blocks for mcp-query. Optional, tree-shakeable —
// import from `mcp-query/server`.

export { authorize, denyDestructiveUnless, AuthorizationError } from "./authorize.js";
export type { AuthzVerdict, AuthzRequest } from "./authorize.js";
export { createGateway, createGatewayHandler, GatewayUpstreamCapabilityError } from "./gateway.js";
export type { GatewayOptions, GatewayHandlerOptions } from "./gateway.js";
export { circuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
export type { CircuitOptions, CircuitBreaker } from "./circuitBreaker.js";
export { rateLimit } from "./rateLimit.js";
export type { RateLimitOptions, RateLimit } from "./rateLimit.js";
export { x402Interceptor, X402ChallengeError } from "./x402Interceptor.js";
export type { X402InterceptorOptions, X402GateVerdict } from "./x402Interceptor.js";
export { parseX402Challenge } from "./x402.js";
export type { X402Challenge, X402PaymentRequirement } from "./x402.js";
