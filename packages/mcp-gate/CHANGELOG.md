# @johnhenry/mcp-gate

## 0.7.0

### Minor Changes

- 8596e26: Forwarded interaction rounds (`interactions: "forward"`) now guard the consumer's answers on their way upstream. mcp-gate applies its `redact` rules to `inputResponses` (never to `requestState`, which stays byte-for-byte), and a new `answerPolicy` config (rules or a function receiving an `AuthzRequest` with `kind: "answer"`) gives allow / deny / approve a say per answer: a denied answer becomes `{ action: "decline" }`. With no `answerPolicy`, answers are allowed as before. The answer hop's audit entry records `redactedFields` and `declined` (names only). mcp-query adds the `guardAnswers` gateway option and its types, `AuthzRequest.kind: "answer"`, and the audit fields. It also fixes the gateway's `-32004` `GatewayUpstreamCapabilityError` translation, which never fired because `MCPClient` wraps the SDK error in an `MCPError` first: consumers of an `answer`/`deny` gateway now get `-32004` instead of the upstream's raw `-32021` (forwarding gateways keep `-32021`, which names the consumer's own missing capability).
- f93f134: `authorize`, `redact` and `audit` now see `prompts/get` (kind `prompt`, matched by the existing `server.prompt` globs), the skills calls (kind `skill`) and catalog views (kind `list`). Declarative policies leave `list` and `skill` allowed, so existing configs keep working; function policies receive every kind. Name-denied items are hidden from the client's own `listTools()`/`listResources()`/`listPrompts()` (library mode included) the way the gateway already hides them, and `approval.discovery: "annotated"` stamps `_meta.requiresApproval` there. `redact` scrubs prompt results and skill file text (marking the file `verified: false`) and leaves catalog names alone. Requires the `@johnhenry/mcp-query` version carrying these operation kinds.
- 103acf6: Gateway MRTR pass-through (#82, slice 1). `createGateway` / `createGatewayHandler` take `interactions: "answer" | "forward" | "deny"` (or `{ default, upstreams }`): with `"forward"`, an upstream `input_required` result on a 2026-07-28 connection is returned to the gateway's consumer (`requestState` untouched) and the consumer's retry is routed back to the same upstream; the default `"answer"` is unchanged. `MCPClient.callTool` / `getPrompt` accept `interaction` (manual MRTR), an interim `input_required` result is never cached, and `CallAuditEntry` gains `interaction`. `@johnhenry/mcp-gate` adds the `interactions` config key, a fail-closed `urlElicitation` allow/deny host policy for forwarded URL-mode elicitations, and redaction that leaves `requestState` alone.

### Patch Changes

- Updated dependencies [a3ab7bb]
- Updated dependencies [8596e26]
- Updated dependencies [103acf6]
- Updated dependencies [f93f134]
- Updated dependencies [739cf37]
- Updated dependencies [5766b56]
- Updated dependencies [98c45c2]
  - @johnhenry/mcp-query@0.6.0

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
