---
"@johnhenry/mcp-query": patch
---

`webMcpToolServer` now works against native WebMCP and `@mcp-b/global` 5.1: it calls `executeTool(tool, inputArgumentsJson)` with the descriptor from `getTools()` and parses the JSON-string (or `null`) result, parses string `inputSchema`s, falls back to `navigator.modelContextTesting.executeTool(name, json)`, and keeps the legacy `executeTool(name, args)` shape for hosts whose tools carry `execute`. The default model context also falls back to `navigator.modelContext`, and `bridgeToWebMCP` no longer leaks an unhandled rejection from native `registerTool` returning a rejected promise (#54).
