---
"@johnhenry/mcp-query-ui": minor
---

Let the host configure the app frame. `createAppHost({ frame: { csp, permissions } })` takes extra or overriding CSP directives, host-added domains and an `allow`-list filter; `mountIframe` takes `sandbox` tokens (inner and extra outer) and a host-supplied `iframe` element or factory. Defaults are unchanged and the app-declared CSP stays a ceiling: tightening is free, anything wider needs an explicit `unsafeLoosen` flag, and the proxy must still be a different origin, the inner frame never gets `allow-same-origin` through `sandbox.inner`, and a supplied iframe cannot carry `srcdoc`. New exports: `applyHostCspDirectives`, `resolveSandbox`, `KNOWN_SANDBOX_TOKENS`.
