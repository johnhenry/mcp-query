# @johnhenry/mcp-query-ui

## 0.1.0

### Minor Changes

- 2faddd8: Initial release: an MCP Apps (SEP-1865, `io.modelcontextprotocol/ui`) host built on the official
  `@modelcontextprotocol/ext-apps` host helpers. `createAppHost()` mounts a `ui://` app resource in a sandboxed
  iframe (`mountIframe`, double-iframe sandbox proxy) and bridges the app's `tools/call` and `resources/read`
  through the `MCPClient`, so cache, interceptors and mcp-gate policy/approval/audit apply to app-initiated
  traffic. App lifecycle, messages and calls are subscribable state; `@johnhenry/mcp-query-ui/react` adds
  `useMcpApp()`. CSP domains declared by the app are validated and never loosened.

### Patch Changes

- Updated dependencies [2faddd8]
  - @johnhenry/mcp-query@0.3.1
