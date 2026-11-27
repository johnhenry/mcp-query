# @johnhenry/mcp-query

## 0.6.0

### Minor Changes

- a3ab7bb: Add a `@johnhenry/mcp-query/browser-bundle` export: one self-contained, minified ESM file (`dist/browser/mcp-query.browser.js`) with the MCP SDK client, zod and agent-query-core inlined, plus the browser-safe parts of `@johnhenry/mcp-gate` (`createGateClient`, policy and redaction helpers). One import in a browser makes no further requests, so hosts can pin and vendor it. React hooks stay out of the bundle. Existing export paths are unchanged. The README has a size table (`npm run size-table`).
- 8596e26: Forwarded interaction rounds (`interactions: "forward"`) now guard the consumer's answers on their way upstream. mcp-gate applies its `redact` rules to `inputResponses` (never to `requestState`, which stays byte-for-byte), and a new `answerPolicy` config (rules or a function receiving an `AuthzRequest` with `kind: "answer"`) gives allow / deny / approve a say per answer: a denied answer becomes `{ action: "decline" }`. With no `answerPolicy`, answers are allowed as before. The answer hop's audit entry records `redactedFields` and `declined` (names only). mcp-query adds the `guardAnswers` gateway option and its types, `AuthzRequest.kind: "answer"`, and the audit fields. It also fixes the gateway's `-32004` `GatewayUpstreamCapabilityError` translation, which never fired because `MCPClient` wraps the SDK error in an `MCPError` first: consumers of an `answer`/`deny` gateway now get `-32004` instead of the upstream's raw `-32021` (forwarding gateways keep `-32021`, which names the consumer's own missing capability).
- 103acf6: Gateway MRTR pass-through (#82, slice 1). `createGateway` / `createGatewayHandler` take `interactions: "answer" | "forward" | "deny"` (or `{ default, upstreams }`): with `"forward"`, an upstream `input_required` result on a 2026-07-28 connection is returned to the gateway's consumer (`requestState` untouched) and the consumer's retry is routed back to the same upstream; the default `"answer"` is unchanged. `MCPClient.callTool` / `getPrompt` accept `interaction` (manual MRTR), an interim `input_required` result is never cached, and `CallAuditEntry` gains `interaction`. `@johnhenry/mcp-gate` adds the `interactions` config key, a fail-closed `urlElicitation` allow/deny host policy for forwarded URL-mode elicitations, and redaction that leaves `requestState` alone.
- f93f134: The interceptor chain now covers `getPrompt` (`kind: "prompt"`), the skills calls `listSkills`/`getSkill`/`readSkillFile` (`kind: "skill"`) and the catalogs behind `listTools`/`listResources`/`listResourceTemplates`/`listPrompts` (`kind: "list"`, run where the catalog is fetched or re-fetched, so the synchronous accessors return what the chain answered and a throwing interceptor hides the catalog). New: `OperationKind` gains `list | prompt | skill`, `Operation.method`, `CatalogName`, async `client.discover(catalog, server?, { context })` (also on `scope()`, plus `scope().getPrompt`), and `listFilter({ keep, annotate })` in `@johnhenry/mcp-query/server`. Interceptors written against `read | call | query` keep working if they pass other kinds to `next`. `authorize()` treats `"approve"` on a `list` as allow, `rateLimit` and `circuitBreaker` skip `list`, and a synchronous throw from an interceptor is now audited like an async one. An `authorize` policy that denies every kind it does not recognise will now also deny the new kinds.
- 739cf37: Add `@johnhenry/mcp-query/discovery`: Zod schemas for MCP Server Cards (SEP-2127) and the AI Catalog envelope, `fetchServerCard(url, opts)`, `discoverFromDomain(domain, opts)` (reads `/.well-known/ai-catalog.json`), remote URL resolution, and `compareCardToLive` to flag disagreement with a live server. Fetches are HTTPS-only (loopback http behind an explicit option), size-capped, time-limited, refuse cross-origin redirects, check the content type and accept an injectable `fetch`; results are untrusted display data and nothing is registered or connected.
- 5766b56: Skills over MCP (`io.modelcontextprotocol/skills`, SEP-2640): `connection.supports("skills")`, `client.listSkills(server?)`, `client.getSkill(uri, server)` and `client.readSkillFile(skill, ref?)` built on the SDK's `SkillsClient`, so size, digest and frontmatter verification is the SDK's and failures surface as `MCPError` with the reason preserved (`skillVerificationReason`). Listings honor SEP-2549 `ttlMs`/`cacheScope`, are keyed per server and `client.scope()` partition, go stale on `resources/list_changed`, and verified files are cached by manifest digest. Adds `useSkills` / `useSkill` and a `MockMCPServer` `skills` fixture (including tampered-digest/size/frontmatter cases). Needs `@modelcontextprotocol/client` >= 2.4.0 at call time; the peer range is unchanged and older SDKs get a clear `MCPError` naming the minimum version.
- 98c45c2: Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) now works on 2026-07-28 connections when the installed `@modelcontextprotocol/client` is 2.3.0 or newer: `callToolTask`, `getTask`, `cancelTask` and `input_required` rounds via `tasks/update`. The unconditional modern-era gate is replaced by a runtime probe of the SDK, so SDK 2.0.x (still within the `^2.0.0` peer range) fails fast with an accurate message that names the 2.3.0 requirement. Modern-era task status is poll-only because the SDK client has no `taskIds` filter for `subscriptions/listen`.

## 0.5.0

### Minor Changes

- 999aba4: `queryTool(name, args, { signal })` lets a caller cancel its own wait: that caller's promise rejects with an `AbortError` when its signal fires (immediately, without starting a request, if it is already aborted). The underlying request, which is de-duplicated across callers, is cancelled only once every caller waiting on it has aborted; a cancelled fetch no longer marks the cache entry as errored. `MockMCPServer` tool handlers also receive the request's `signal` on their context.

## 0.4.0

### Minor Changes

- 899de5b: `webMcpToolServer` now passes `annotations` and `title` from `getTools()` descriptors through to `tools/list`, and sends `notifications/tools/list_changed` when the model context fires a `toolchange` event (the listener is removed when the transport closes).

## 0.3.2

### Patch Changes

- a3730ae: `webMcpToolServer` now works against native WebMCP and `@mcp-b/global` 5.1: it calls `executeTool(tool, inputArgumentsJson)` with the descriptor from `getTools()` and parses the JSON-string (or `null`) result, parses string `inputSchema`s, falls back to `navigator.modelContextTesting.executeTool(name, json)`, and keeps the legacy `executeTool(name, args)` shape for hosts whose tools carry `execute`. The default model context also falls back to `navigator.modelContext`, and `bridgeToWebMCP` no longer leaks an unhandled rejection from native `registerTool` returning a rejected promise (#54).

## 0.3.1

### Patch Changes

- 2faddd8: Add an opt-in `extensions` option to `MCPClientConfig` for advertising extra MCP extensions in
  `capabilities.extensions` (e.g. `io.modelcontextprotocol/ui` for an MCP Apps host); the built-in tasks
  extension is unaffected. `MockMCPServer` (`@johnhenry/mcp-query/testing`) gains `_meta` on tools/resources and a
  `clientCapabilities()` accessor.

## 0.3.0

### Minor Changes

- 25b09fd: `MCPCache.onExternalInvalidate(listener)` (reachable as `client.cache.onExternalInvalidate`): register a listener on an already-constructed cache that fires on every tag/key invalidation, protocol-driven or declared, whether or not a local entry matches. Returns an unsubscribe function; a constructor-supplied `events.onExternalInvalidate` keeps working. Exports the `ExternalInvalidateEvent` type (#24).

## 0.2.2

### Patch Changes

- 48b6dad: Widen the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` ranges from the exact `2.0.0` to `^2.0.0`, so consumers on any 2.x SDK install without `ERESOLVE` peer warnings. In `@johnhenry/mcp-query` these are peer dependencies; in `@johnhenry/mcp-gate` they are regular dependencies, so the wider range lets npm dedupe to the single SDK copy the consumer already has instead of installing a second 2.0.0. The suite passes against SDK 2.0.0 (the floor) and the latest 2.x (2.3.1), and CI now runs the SDK-using packages against both (#42).
