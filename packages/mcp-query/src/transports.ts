// Transport re-exports — the v2 SDK transports mcp-query connections are built
// from, republished so consumers construct transports from the SAME package copy
// the client validates against (v1/v2 SDK objects must never mix). Import from
// `@johnhenry/mcpq/transports` instead of depending on @modelcontextprotocol/client
// directly.
//
// Note: `StdioClientTransport` intentionally lives on its own subpath in the SDK
// (it drags in child_process); we re-export it here for Node consumers — browser
// bundlers that tree-shake unused exports are unaffected.

export {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  InMemoryTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
export type {
  SSEClientTransportOptions,
  StreamableHTTPClientTransportOptions,
  Transport,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
export { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
export type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
