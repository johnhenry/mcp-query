// Browser-safe upstream resolution (#65). Only `@modelcontextprotocol/client`'s main entry
// is imported here (fetch-based Streamable HTTP, no `node:` builtins), so this module is safe
// in a browser bundle, unlike ./upstream.ts which also builds stdio transports.

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ConnectionConfig } from "@johnhenry/mcp-query";
import type { GateUpstream } from "./config.js";

/**
 * Normalize an upstream to a ConnectionConfig without any Node-only transport. A full
 * `ConnectionConfig` passes through, `{ url }` becomes a Streamable HTTP transport factory,
 * and a stdio `{ command }` spec throws (a browser cannot spawn a process; put a
 * WebSocket-to-stdio bridge transport in a `ConnectionConfig` instead).
 */
export function resolveHttpUpstream(upstream: GateUpstream): ConnectionConfig {
  if ("transport" in upstream) return upstream;
  if ("command" in upstream) {
    throw new Error(
      "stdio upstreams ({ command }) need Node; in a browser pass a ConnectionConfig whose transport is a bridge, or an { url } upstream",
    );
  }
  const { url, headers, getToken } = upstream;
  return {
    transport: () =>
      new StreamableHTTPClientTransport(new URL(url), {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(getToken ? { authProvider: { token: async () => getToken() } } : {}),
      }),
  };
}
