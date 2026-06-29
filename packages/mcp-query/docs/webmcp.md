# WebMCP bridge (experimental)

> **Status: experimental, draft-tracking.** [WebMCP](https://github.com/webmachinelearning/webmcp)
> (W3C Web ML CG) is early — `document.modelContext.registerTool()` is draft-standardized,
> but discovery/invocation (`getTools`/`executeTool`) and any transport are still TODO, and
> it is **tools-only**. This module (`mcp-query/webmcp`) lives outside the core and may
> change with the spec.

## Why two adapters (and the role inversion)

WebMCP and mcp-query point in **opposite directions**:

- **WebMCP**: the *web page is the server* (it registers tools); the *in-browser agent is
  the client* (it discovers/invokes them). Tools only.
- **mcp-query**: a *client* that consumes real MCP servers as a reactive data layer.

So "compatibility" is two distinct bridges. Both bind at the JS-object level — WebMCP is
**not** JSON-RPC, so there's no transport to plug in; instead we proxy through a small
in-memory MCP server / direct `registerTool` calls.

## B — `bridgeToWebMCP(client, server, opts?)` (the useful one)

Re-expose a connected backend server's tools to the in-browser agent. Each `execute` routes
through `client.callTool`, so the **broker (approval), cache, and invalidation all apply** —
mcp-query becomes the bridge that lets a WebMCP agent reach your real servers. Stays in sync
with `tools/list_changed`; returns `stop()`.

```ts
import { bridgeToWebMCP, isDestructive } from "mcp-query/webmcp"; // (isDestructive from "mcp-query")

const stop = bridgeToWebMCP(client, "backend", {
  confirm: ({ tool, args }) => !isDestructive(tool) || window.confirm(`Run ${tool.name}?`),
  name: (server, tool) => `${server}.${tool.name}`, // optional
  include: (tool) => tool.name !== "internal_only",  // optional
});
```

## A — `webMcpToolServer(modelContext?)` (interface symmetry)

Consume a page's WebMCP tools as an ordinary mcp-query server (an in-memory MCP server
proxying to `getTools`/`executeTool`). Plug it into `new MCPClient` and those tools get
caching, the broker, and devtools like any other server — unifying both directions on one
client.

```ts
import { webMcpToolServer } from "mcp-query/webmcp";

const client = new MCPClient({
  servers: {
    backend: { transport: () => httpTransport },
    page: webMcpToolServer(), // the page's document.modelContext tools
  },
});
```

Honest caveat: consuming your *own* page's tools is circular; A mainly earns its keep for
**cross-origin tool aggregation** (tools exposed by embedded third-party widgets/iframes via
`exposedTo` / `allow="tools"`) and for interface completeness.

## What doesn't map (and why that's fine)

- **Tools-only** — no resources, prompts, subscriptions, or `resources/updated`. The bridge
  ignores them; the consumer surfaces only tools. Most of mcp-query's machinery is simply
  unused on the WebMCP side.
- **No capability negotiation / no JSON-RPC** — handled by the in-memory server shim; there's
  no handshake to translate.
- **Permission model** — WebMCP's `exposedTo` / `allow="tools"` is the host's concern;
  mcp-query's `confirm` hook and broker complement it (human approval for agent tool calls).

See [`examples/08-webmcp-bridge.tsx`](../examples/08-webmcp-bridge.tsx) and
`test/webmcp.test.ts`.
