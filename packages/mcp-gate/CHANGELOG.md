# @johnhenry/mcp-gate

## 0.6.2

### Patch Changes

- Updated dependencies [999aba4]
  - @johnhenry/mcp-query@0.5.0

## 0.6.1

### Patch Changes

- Updated dependencies [899de5b]
  - @johnhenry/mcp-query@0.4.0

## 0.6.0

### Minor Changes

- 9fc9d0a: Additive options so an embedding gate can use `./policy` and `./redact` directly (#70): `emptyAllow` (`"ignore"` treats `allow: []` as no allow list), `scope: "tool"` (globs over the bare tool name, optionally per server), `explainPolicy()` returning `{ decision, rule? }` with the list and glob that decided, redact rule `flags`, and a `defaultReplacement` option. Defaults keep the current behaviour.

## 0.5.0

### Minor Changes

- ec9fe4a: Browser-safe library mode (#65). New `createGateClient(config)` runs the whole governed interceptor stack (policy, approval, circuit breaker, rate limit, redaction, audit) around an `MCPClient` with no gateway server and no Node-only imports; upstreams are a `ConnectionConfig` or an `{ url }` spec (`resolveHttpUpstream`). The browser entry now also exports `createGateClient`, `redactValue(rules, value)` (redact any value directly), `resolveHttpUpstream` and the approval types. New subpath exports `@johnhenry/mcp-gate/policy` and `@johnhenry/mcp-gate/redact` import the policy compiler and the redactors on their own. A test bundles each browser entry for a browser platform and fails on any Node-only module.

## 0.4.2

### Patch Changes

- 25b09fd: `gate.close()` (and `removeUpstream`/`updateUpstream`) now resolve only after every spawned stdio child has actually exited. Declarative `{ command }` upstreams use a transport that, after the SDK's stdin-close / SIGTERM escalation, SIGKILLs a child that is still alive and awaits its exit, so a child that ignores SIGTERM can no longer outlive `close()` (#23).
- Updated dependencies [25b09fd]
  - @johnhenry/mcp-query@0.3.0

## 0.4.1

### Patch Changes

- 48b6dad: Widen the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` ranges from the exact `2.0.0` to `^2.0.0`, so consumers on any 2.x SDK install without `ERESOLVE` peer warnings. In `@johnhenry/mcp-query` these are peer dependencies; in `@johnhenry/mcp-gate` they are regular dependencies, so the wider range lets npm dedupe to the single SDK copy the consumer already has instead of installing a second 2.0.0. The suite passes against SDK 2.0.0 (the floor) and the latest 2.x (2.3.1), and CI now runs the SDK-using packages against both (#42).
- Updated dependencies [48b6dad]
  - @johnhenry/mcp-query@0.2.2
