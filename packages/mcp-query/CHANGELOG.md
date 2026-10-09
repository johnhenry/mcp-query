# @johnhenry/mcp-query

## 0.3.2

### Patch Changes

- a3730ae: `webMcpToolServer` now works against native WebMCP and `@mcp-b/global` 5.1: it calls `executeTool(tool, inputArgumentsJson)` with the descriptor from `getTools()` and parses the JSON-string (or `null`) result, parses string `inputSchema`s, falls back to `navigator.modelContextTesting.executeTool(name, json)`, and keeps the legacy `executeTool(name, args)` shape for hosts whose tools carry `execute`. The default model context also falls back to `navigator.modelContext`, and `bridgeToWebMCP` no longer leaks an unhandled rejection from native `registerTool` returning a rejected promise (#54).

## 0.3.1

### Patch Changes

- 2faddd8: Add an opt-in `extensions` option to `MCPClientConfig` for advertising extra MCP extensions in
  `capabilities.extensions` (e.g. `io.modelcontextprotocol/ui` for an MCP Apps host); the built-in tasks
  extension is unaffected. `MockMCPServer` (`@johnhenry/mcp-query/testing`) gains `_meta` on tools/resources and a
  `clientCapabilities()` accessor.

## 0.3.0

### Minor Changes

- 25b09fd: `MCPCache.onExternalInvalidate(listener)` (reachable as `client.cache.onExternalInvalidate`): register a listener on an already-constructed cache that fires on every tag/key invalidation, protocol-driven or declared, whether or not a local entry matches. Returns an unsubscribe function; a constructor-supplied `events.onExternalInvalidate` keeps working. Exports the `ExternalInvalidateEvent` type (#24).

## 0.2.2

### Patch Changes

- 48b6dad: Widen the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` ranges from the exact `2.0.0` to `^2.0.0`, so consumers on any 2.x SDK install without `ERESOLVE` peer warnings. In `@johnhenry/mcp-query` these are peer dependencies; in `@johnhenry/mcp-gate` they are regular dependencies, so the wider range lets npm dedupe to the single SDK copy the consumer already has instead of installing a second 2.0.0. The suite passes against SDK 2.0.0 (the floor) and the latest 2.x (2.3.1), and CI now runs the SDK-using packages against both (#42).
