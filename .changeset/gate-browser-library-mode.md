---
"@johnhenry/mcp-gate": minor
---

Browser-safe library mode (#65). New `createGateClient(config)` runs the whole governed interceptor stack (policy, approval, circuit breaker, rate limit, redaction, audit) around an `MCPClient` with no gateway server and no Node-only imports; upstreams are a `ConnectionConfig` or an `{ url }` spec (`resolveHttpUpstream`). The browser entry now also exports `createGateClient`, `redactValue(rules, value)` (redact any value directly), `resolveHttpUpstream` and the approval types. New subpath exports `@johnhenry/mcp-gate/policy` and `@johnhenry/mcp-gate/redact` import the policy compiler and the redactors on their own. A test bundles each browser entry for a browser platform and fails on any Node-only module.
