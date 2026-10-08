---
"@johnhenry/mcp-query": patch
---

Add an opt-in `extensions` option to `MCPClientConfig` for advertising extra MCP extensions in
`capabilities.extensions` (e.g. `io.modelcontextprotocol/ui` for an MCP Apps host); the built-in tasks
extension is unaffected. `MockMCPServer` (`@johnhenry/mcp-query/testing`) gains `_meta` on tools/resources and a
`clientCapabilities()` accessor.
