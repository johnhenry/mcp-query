// Transport re-exports — the v2 SDK transports mcp-query connections are built
// from, republished so consumers construct transports from the SAME package copy
// the client validates against (v1/v2 SDK objects must never mix). Import from
// `@johnhenry/mcp-query/transports` instead of depending on @modelcontextprotocol/client
// directly.
//
// Note: `StdioClientTransport` intentionally lives on its own subpath in the SDK
// (it drags in child_process); we re-export it here for Node consumers — browser
// bundlers that tree-shake unused exports are unaffected.

import { SSEClientTransport as SdkSSEClientTransport } from "@modelcontextprotocol/client";
import type { SSEClientTransportOptions as SdkSSEClientTransportOptions } from "@modelcontextprotocol/client";

/**
 * The legacy HTTP+SSE client transport.
 *
 * @deprecated HTTP+SSE (deprecated since protocol 2025-03-26) is reclassified as Deprecated by the
 * 2026-07-28 revision's feature lifecycle policy (SEP-2596); it stays available for at least twelve
 * months. Use `StreamableHTTPClientTransport`. (SEP-2577 deprecates Sampling, Roots and Logging, not this
 * transport; SEP-2596 is the one that covers it.)
 */
export const SSEClientTransport = SdkSSEClientTransport;
/** @deprecated See the {@link SSEClientTransport} value: HTTP+SSE is Deprecated (SEP-2596). */
export type SSEClientTransport = SdkSSEClientTransport;
/** @deprecated HTTP+SSE is Deprecated (SEP-2596). Use `StreamableHTTPClientTransportOptions`. */
export type SSEClientTransportOptions = SdkSSEClientTransportOptions;

export {
  StreamableHTTPClientTransport,
  InMemoryTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
export type {
  StreamableHTTPClientTransportOptions,
  Transport,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
export { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
export type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
