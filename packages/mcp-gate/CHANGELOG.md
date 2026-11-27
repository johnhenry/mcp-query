# @johnhenry/mcp-gate

## 0.9.0

### Minor Changes

- fb816ff: `interactions: "forward"` covers `resources/read` and 2025-era upstreams (their elicitation is relayed to the consumer, with `redact`, `urlElicitation`, `answerPolicy` and audit applied on both hops); new `interactionTimeoutMs` and `createRequestGuard`. `subscriptions/listen` is refused without a verified token when `inboundAuth.required`, and a tool the gate hides being added upstream no longer triggers a `list_changed`. Documented in the README.

### Patch Changes

- Updated dependencies [9f272bb]
- Updated dependencies [fb816ff]
  - @johnhenry/mcp-query@0.8.0

## 0.8.0

### Minor Changes

- 1a9f81b: EXPERIMENTAL, may change: policy for the MCP files extension (`io.modelcontextprotocol/files`, a draft with no SEP). Uploads bypass the gate by design (the client sends bytes straight to a URL the server names), so the gate denies them: an `upload_required` round is refused (`-32003`, audited, hosts named, never the URL) unless every upload host matches `experimental.files.allowUploadHosts`; an allowed upload performed by the gate's own client is audited with file name, size, digest and host, never content. Download URLs in results follow `allowDownloadHosts` (non-allowlisted entries are stripped, or the call refused with `downloads: "refuse"`), and `maxFileSize` / `accept` limit `x-mcp-file` arguments. The upload refusal is always on; the rest applies only when `experimental.files` is set, and the gate declares nothing to upstreams unless `upload` / `download` is set. `validateGateConfig` checks the new keys. Exports `filesGuard`, `hostAllowed` and `GateFilesPolicy`.
- a1dfc17: Gate: extensions (#82 items 3, 4, 5). New `extensions` config (allow / deny / opt-in `passthrough` of unknown extension methods / `tasksSecret`). Tasks: `redact` scrubs a completed task's inlined `result`, `inputRequests`, `error` and `statusMessage` but never ids; URL-mode elicitations inside a task obey `urlElicitation` (now always enforced); `tasks/update` answers go through `answerPolicy` and `redact`; polls, answers and cancels are policy-checked and audited as `kind: "task"`. Skills: new `policy.skills` allow / deny / approve rules for whole skills (and `policySkillFilter`). **Behaviour change:** `redact` no longer scrubs skill file text (it used to, marking the file `verified: false`); a skill's digest covers its bytes, so the gate never rewrites a skill. MCP Apps: the gate declares the UI extension to upstreams unless `extensions.deny` lists it, and hands UI metadata only to consumers that declared it.
- fc9a255: Routing headers (SEP-2243) at the gate: `gate.handler()` answers HeaderMismatch (-32020) for headers that disagree with the body, and policy, rate limit and audit read the body-verified `context.routing` (method, name, `x-mcp-header` values; `entry.routing` on audit entries). New `rateLimit.keyFn` replaces the default per-(upstream, tenant) bucket key. Cache hints and per-request `_meta` forwarding follow the gateway changes in `@johnhenry/mcp-query`; see the README section "Routing headers and cache hints".
- e3f8f5c: The gate can publish a Server Card (SEP-2127) for its own endpoint: `GateConfig.card` (`url`, `name`, `version`, optional `description`/`title`/`websiteUrl`/`supportedProtocolVersions`/`listUpstreams`), `gateServerCard(config)` for the card object, and `createGateCardHandler(config)`, a web-standard `(req: Request) => Response | undefined` that serves it at `<endpoint>/server-card` (the SEP's reserved location, with the card media type, CORS and cache headers) and falls through for every other path so it composes in front of your MCP handler. The card describes only the gate (identity, its transport endpoint, supported protocol versions) and says nothing about upstreams unless `card.listUpstreams: true`, which publishes upstream names only (never URLs, commands or headers). The gate has no HTTP server of its own, so mounting is documented in the README.
- 3363512: HTTP upstreams accept `auth: { type: "client_credentials", ... }` and `auth: { type: "enterprise", ... }` next to `getToken`, with secrets by reference only (`{ env }` or `{ get }`; `validateGateConfig` rejects inline secret strings), a required `issuer` that credentials are bound to, and an expiry-aware, single-flight token cache that never reaches audit entries. Enterprise-managed authorization is built against a mock identity provider and is untested against a real one. New `inboundAuth` config and `gate.handler()` let you front the gate with the SDK's `requireBearerAuth` / `verifyBearerToken` and use the verified principal in `policy` and `partitionFrom`.

### Patch Changes

- Updated dependencies [3363512]
- Updated dependencies [e3f8f5c]
- Updated dependencies [3cc0f6e]
- Updated dependencies [7f4791b]
- Updated dependencies [1a9f81b]
- Updated dependencies [a1dfc17]
- Updated dependencies [fc9a255]
- Updated dependencies [d1839fe]
  - @johnhenry/mcp-query@0.7.0

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
