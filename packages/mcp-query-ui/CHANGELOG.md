# @johnhenry/mcp-query-ui

## 2.1.0

### Minor Changes

- 42d809c: Opt-in app capabilities, all off by default: `appCapabilities: { resourcesList, promptsList, sampling, updateModelContext }` on `createAppHost`, with `interactions` (an `InteractionBroker`, defaulting to `client.interactions`), `onUpdateModelContext` and `approvalTimeoutMs`. A request for a capability that is off is refused with a clear error and recorded as `denied` in `state.calls`; enabled ones are tracked there too (`AppCall.kind` gains `resources-list | prompts-list | sampling | model-context`). Sampling needs a broker so policy or a human approves it, and is discouraged because it is deprecated in the core protocol (SEP-2577). `prompts/get` is not offered because ext-apps' `AppBridge` has no handler for it.
- f93f134: An app's opted-in `resources/list` and `prompts/list` now run through the client's interceptor chain (`client.discover`, principal `mcp-app:<uri>`), so mcp-gate policy, audit and any user interceptor apply to them and a deny or filter is reflected in the app's list. Still off by default, still gated first by the InteractionBroker `confirm` step, still recorded in `state.calls`; a client without `discover` falls back to its synchronous lists. A tool the gate policy hides from `listTools` is still refused by the policy (`denied`) rather than reported as unknown.
- 42d809c: Let the host configure the app frame. `createAppHost({ frame: { csp, permissions } })` takes extra or overriding CSP directives, host-added domains and an `allow`-list filter; `mountIframe` takes `sandbox` tokens (inner and extra outer) and a host-supplied `iframe` element or factory. Defaults are unchanged and the app-declared CSP stays a ceiling: tightening is free, anything wider needs an explicit `unsafeLoosen` flag, and the proxy must still be a different origin, the inner frame never gets `allow-same-origin` through `sandbox.inner`, and a supplied iframe cannot carry `srcdoc`. New exports: `applyHostCspDirectives`, `resolveSandbox`, `KNOWN_SANDBOX_TOKENS`.

## 2.0.0

### Patch Changes

- Updated dependencies [999aba4]
  - @johnhenry/mcp-query@0.5.0

## 1.0.0

### Patch Changes

- Updated dependencies [899de5b]
  - @johnhenry/mcp-query@0.4.0

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
