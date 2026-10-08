---
"@johnhenry/mcp-query-ui": minor
---

Initial release: an MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`) host built on the official
`@modelcontextprotocol/ext-apps` host helpers. `createAppHost()` mounts a `ui://` app resource in a sandboxed
iframe (`mountIframe`, double-iframe sandbox proxy) and bridges the app's `tools/call` and `resources/read`
through the `MCPClient`, so cache, interceptors and mcp-gate policy/approval/audit apply to app-initiated
traffic. App lifecycle, messages and calls are subscribable state; `@johnhenry/mcp-query-ui/react` adds
`useMcpApp()`. CSP domains declared by the app are validated and never loosened.
