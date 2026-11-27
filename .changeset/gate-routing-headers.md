---
"@johnhenry/mcp-gate": minor
---

Routing headers (SEP-2243) at the gate: `gate.handler()` answers HeaderMismatch (-32020) for headers that disagree with the body, and policy, rate limit and audit read the body-verified `context.routing` (method, name, `x-mcp-header` values; `entry.routing` on audit entries). New `rateLimit.keyFn` replaces the default per-(upstream, tenant) bucket key. Cache hints and per-request `_meta` forwarding follow the gateway changes in `@johnhenry/mcp-query`; see the README section "Routing headers and cache hints".
