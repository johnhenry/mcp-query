---
"@johnhenry/mcp-query": minor
---

Browser support for hosts like Viaframe (#63, #64). New `@johnhenry/mcp-query/bridge` (browser-safe): `WebSocketBridgeTransport`, the documented WebSocket-to-MCP bridge protocol types (`TargetSpec`, `ClientFrame`, `BridgeFrame`) and the Streamable HTTP CORS contract (`mcpCorsHeaders`, `MCP_CORS_ALLOW_HEADERS`, `MCP_CORS_EXPOSE_HEADERS`). New `@johnhenry/mcp-query/bridge/server` (Node, optional peer `ws`): `startBridge`, a reference bridge with token auth, Origin allowlist and an `allowTarget` hook. New `@johnhenry/mcp-query/browser` entry and a single self-contained ES module build, `@johnhenry/mcp-query/bundle` (minified, ~97 kB gzip, no peer dependencies, no further requests; `/bundle.dev` is unminified), with a size table in the README. README gains an "In the browser" section.
