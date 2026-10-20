// Browser-safe bridge exports. The Node reference server is `@johnhenry/mcp-query/bridge/server`.
export { WebSocketBridgeTransport } from "./client.js";
export { MCP_CORS_ALLOW_HEADERS, MCP_CORS_EXPOSE_HEADERS, mcpCorsHeaders } from "./protocol.js";
export type { TargetSpec, ClientFrame, BridgeFrame } from "./protocol.js";
