// Node-only transport resolution for declarative upstreams (#37). Split out of config.ts:
// GateConfig/GatePolicy/compilePolicy/policyListFilter in config.ts are pure logic with zero
// runtime imports — safe to bundle for a browser dashboard. Building an actual stdio
// transport isn't: `@modelcontextprotocol/client/stdio` imports `cross-spawn` and
// `node:stream` at module scope, and spawning a child process only makes sense in Node
// anyway, so that import lives here instead, in a file the browser entry
// (`index.browser.ts` / the `browser` export condition, see package.json) never reaches —
// not even transitively. That's what actually fixes #37: the package `browser` condition
// resolves `.` to a graph that never imports this module, so a bundler never has to resolve
// cross-spawn/node:stream at all, static or dynamic.
//
// (`resolveUpstream`'s `transport` field must stay a *synchronous* `() => Transport` — see
// mcp-query's `ConnectionConfig.transport: (ctx?) => Transport` — so a lazy `await import()`
// inside the returned factory isn't an option here; the import has to happen eagerly, at
// module scope, in whichever file actually needs it.)

import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ConnectionConfig } from "@johnhenry/mcp-query";
import type { GateUpstream } from "./config.js";

/** Normalize an upstream to a ConnectionConfig, building the transport factory for declarative specs. */
export function resolveUpstream(upstream: GateUpstream): ConnectionConfig {
  if ("transport" in upstream) return upstream;
  if ("command" in upstream) {
    const { command, args = [], env } = upstream;
    return {
      transport: () =>
        new StdioClientTransport({ command, args, ...(env ? { env: { ...getDefaultEnvironment(), ...env } } : {}) }),
    };
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
