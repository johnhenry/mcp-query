# Stress-test findings — July 2026 campaign

A full shakedown of the mcp-query ecosystem: every package CLI driven against real MCP
servers, a committed chaos/load suite for the core client, all seven demo apps exercised
in a browser, and two new apps built to cover the features nothing exercised. This
document records what was broken (and fixed), what's missing, and a prioritized roadmap.

## Method & environment

- macOS (darwin 25.4), Node 22.22, branch `claude/practical-hermann-19d915` off `main@2cfb074`.
- **Baseline** (before any change): typecheck ✓, 332 tests across 15 workspaces ✓, core
  coverage 88.2% stmts, core dist build + smoke import ✓, all 7 app builds ✓.
- **Server matrix**: local stdio (`server-everything` v2.0.0, `server-filesystem`,
  `voice-mode` via uvx), remote Streamable HTTP (Context7, Hugging Face anonymous), and
  OAuth-gated remote (SocialGPT via DCR + PKCE).
- **Surfaces exercised**: `mcp-query` registry/client/daemon verbs; `lint`, `docs`, `bench`,
  `record` (record/replay/inspect), `contract` (snapshot/verify/diff), `gate` (aggregation,
  policy, redaction) — plus the new opt-in stress suite (`npm run test:stress`, 10
  scenario files, hermetic by default, `STRESS_REAL=1` for real-process chaos) and
  browser-driven runs of all apps.

## Fixed in this branch

Each fix has a regression test.

| # | What was broken | Fix |
|---|---|---|
| F1 | **Re-list race**: concurrent `*_list_changed` re-lists could apply out of order, leaving the tool/resource/prompt registry permanently stale after a notification storm | Per-kind generation guard in `ServerConnection.relist` — a superseded response never applies ([connection.ts](../packages/mcp-query/src/core/connection.ts)). Tests: `test/reconnect-state.test.ts`, `test/stress/list-changed-storm.stress.ts` |
| F2 | **State lied during backoff**: after a transport drop, `serverState()` kept reporting `ready` for the whole retry backoff (up to 30s) — health UIs showed a dead server as healthy | `scheduleReconnect` flips `ready`/`degraded` → `reconnecting` immediately | 
| F3 | **Silent reconnect failures**: `reconnect()` swallowed every error (`catch { schedule }`) — a bad proxy token produced an infinite, invisible retry loop | The catch now `console.warn`s per attempt |
| F4 | **`mcp-query login` crashed on macOS**: the browser opener spawned Linux-only `google-chrome-stable` with no child `error` listener; the unhandled `error` event killed the flow including its own paste-URL fallback | Platform-aware launcher chain (`open` / `explorer` / `xdg-open`…) with error-listener fallthrough ([mcp-contract/src/oauth.ts](../packages/mcp-contract/src/oauth.ts)) |
| F5 | **OAuth failed on `"refresh_token": null`**: SocialGPT's token endpoint returns null-valued optional fields; the SDK's zod schema (`z.string().optional()`) rejects null — token exchange and refresh both died | `tokenNormalizingFetch` strips null-valued fields from token-endpoint-shaped bodies, wired into both the login and the capture/refresh transports. Test: `mcp-contract/test/oauth.test.ts` |
| F6 | **Gateway dropped `_meta`**: `createGateway`'s CallTool handler forwarded calls without the caller's `_meta` — tenant/principal propagation (the documented multi-tenant story) died at the gate | Forward `req.params._meta` as `context.meta`. Tests: `test/gateway.test.ts`, switchboard integration |
| F7 | **Codegen ↔ typed hooks never composed**: `createTypedHooks<GeneratedToolMap>` — the exact pairing in typed.ts's own docblock — failed to compile (`GeneratedToolMap` is an interface; `ToolMapShape` demanded a string index signature) | `ToolMapShape<M>` is now mapped over M's own keys. Proven by prompt-studio's committed `mcp.gen.ts` |
| F8 | **`complete()` couldn't do dependent completions**: the SDK supports `context.arguments` (and server-everything's `completable-prompt` requires it) but `client.complete()` didn't expose it | Additive `opts.context` parameter; `MockMCPServer.completions` accepts a context-aware function. Test: `test/capabilities-extra.test.ts`; live-verified: department → per-department names |
| F9 | CLI papercuts: `mcp-query <tool> --help` errored with "provide --url…"; client-verb errors double-printed the `MCP error <code>:` prefix; the 401 hint said `mcp-contract auth` even when invoked as `mcp-query` | Umbrella-level `--help`, duplicate-prefix collapse, `MCPQ_UMBRELLA` env so hints name `mcp-query login` |

Also shipped: `interceptors` on `MakeProxyClientOptions` (apps/shared) — previously
interceptors were unreachable from the app factory.

## What held up well

The stress suite (all green after F1/F2, hermetic + `STRESS_REAL=1`):

- 1k cache subscribers × 500 update bursts: correct fan-out, subscription ref-count
  returns to zero; 500 parallel `callTool` all distinct; 500 identical-key `queryTool`
  dedupe to exactly **one** upstream call.
- 20 forced transport drops + 5 SIGKILLs of a real `server-everything` child: recovered
  every time, zero orphan processes.
- Cancellation: 100 mid-flight aborts — clean rejections, zero post-abort progress leaks.
- 25MB payloads within budget; structural sharing keeps deep-equal payloads
  reference-identical; 50 superseding 5MB writes leave ~one payload in the heap.
- Partition isolation: 50 tenants × 10 interleaved rounds — zero cross-tenant reads;
  `invalidateTags` correctly fans out across all partitions.
- Interceptors: seeded chaos (throw/short-circuit) stays per-call, `op.state` never
  bleeds, `rateLimit` cap never exceeded, `circuitBreaker` opens → fast-fails →
  half-opens on schedule.
- Memory: 10k subscribe/unsubscribe ≈ 0MB growth; 100 connect/close cycles and 10k
  distinct cache keys bounded.
- Redis L2: cross-node hydration without touching the second node's upstream; 1,000-tag
  invalidation storm lossless; TTL honored.

And across the real server matrix: remote Streamable HTTP is genuinely first-class
(ping/tools/call/lint/docs/bench/contract all worked against Context7 + HF), `lint` found
real issues on real servers (missing `readOnlyHint` on 9 of server-everything's tools,
undescribed inputs on HF's `hf_fs`), `contract` verify judged compatibility correctly in
both directions and exits 1 on breaking drift, `record`/replay round-trips offline, the
gate's aggregation + list-filtering + call-denial + deep redaction all behaved against a
live remote upstream, and the `mcp-query` daemon warms repeat calls (~20s → ~6.6s incl. tsx).

## Missing (roadmap, prioritized)

1. **MCP `tasks` capability (spec 2025-11-25) — the headline gap.** The SDK (^1.29)
   supports it and server-everything already advertises it; mcp-query has no
   task-augmented `callTool`, no `tasks/get|list|result|cancel`, no `useTask` hook. The
   cache is a natural fit (a task IS a query with a lifecycle) — this is the next
   differentiating feature.
2. **`MCPError` should be an `Error`.** Rejections are plain objects: `String(e)` →
   `[object Object]`, `instanceof Error` fails, no stack. Make `MCPError` an Error
   subclass (fields preserved — mostly transparent to consumers). Related: aborts surface
   as `kind: "protocol"`; the `"cancelled"` kind exists in the union but is never produced.
3. **Codegen result types.** `outputSchema` is ignored — all 13 server-everything tools
   generate `result: unknown` even when the server declares structured output.
4. **Cache eviction API.** No `clear()`/`remove()`; `gcTime` isn't exposed on
   `ReadResourceOpts`/`QueryToolOpts`. Long sessions can only shed entries via per-entry
   timers.
5. **Record over HTTP.** `mcp-record record` requires `--command` — hosted servers can't
   be recorded. Also: `contract`/`record` bypass the mcp-query registry (names don't resolve).
6. **Gate config DX.** Config-as-code requires SDK imports resolvable from the config's
   directory (fails outside a node project) and `GateConfig` isn't validated — a typo'd
   field (e.g. `replace` vs `replacement`) is silently ignored. A declarative
   `{command|url}` upstream shorthand (the `.mcp.json` format the registry already
   honors) would remove both.
7. **Generic server notifications.** Custom `notifications/*` are dropped;
   `roots/list_changed` is still a TODO.
8. **CLI ergonomics.** Unknown flags are silently swallowed by every tool CLI (typos
   included); `mcp-query call` uses `tool(k: v)` syntax while `bench --call`/`record --call`
   use `tool:{"k":"v"}` — unify; `mcp-query call` ignores progress notifications and doesn't
   advertise roots (`server-filesystem` warns); `ping` on a 403-with-HTML body surfaces a
   raw zod parse error instead of "reachable, requires auth".
9. **`degraded` semantics.** Hardcoded to "connected but zero tools/resources/prompts";
   the code comment claims "app-configurable" but there's no hook. Losing a wanted
   capability (e.g. `resources.subscribe`) downgrades silently to polling with no state
   signal.
10. **`client.listTools()` footguns.** Silently returns `[]` for unknown server names
    (and for JS callers passing nothing); no merged listing across servers.
11. **Apps' proxy params.** With `?proxyToken`/`?proxyPort` missing, apps default to port
    6280 + empty token and retry forever; `makeProxyClient` should fail loudly. (F3's
    warn makes this visible; a UI hint would finish the job.)
12. **Small papercuts**: inspector message log double-escapes HTML entities (`&quot;`);
    `retryDelay` accepts only a function (a number would be friendlier); composer +
    socialgpt-studio builds warn on oversized chunks; README/screenshots reference
    server-everything v1 tool names (`add` → `get-sum` etc. in v2).

## New in this branch (beyond fixes)

- **`packages/mcp-query/test/stress/`** — the opt-in suite described above
  (`npm run test:stress`; see its README for flags and budget philosophy).
- **`apps/prompt-studio`** (5179/6286) — prompts as a product surface: `usePrompt`,
  dependent `completion/complete` typeahead, `useResourceTemplates` → subscribed reads,
  committed codegen output + typed hooks, `persistCache`.
- **`apps/switchboard`** (5180/6287) — one governed endpoint, many tenants: an
  `@johnhenry/mcp-gate` stdio sidecar fronting server-everything + live Context7, an
  interceptor trace waterfall, per-tenant cache partitions via `client.scope()`, a
  governed-vs-direct comparison, and a chaos hammer.

## Round 2 (follow-up PR): the roadmap, addressed

All seven roadmap items above landed in the follow-up branch:

1. **Tasks capability (2025-11-25)** — `client.callToolTask()` returns a live `TaskHandle`
   (cache-backed status via SDK polling AND `notifications/tasks/status` pushes,
   `result()`, `cancel()`), plus `getTask`/`listTasks`/`getTaskResult`/`cancelTask`,
   `supports("tasks")`, `useTask`/`useToolTask` React hooks, and MockMCPServer task
   support (`task: true` tools over the SDK's `InMemoryTaskStore`). Interceptors/audit
   wrap task *initiation*. Interop caveat: the SDK marks tasks experimental and means it —
   `server-everything@2026-07` rejects/ignores task augmentation from SDK 1.29's client
   (`Invalid task creation result`, reproduced with the raw SDK too); within one SDK
   version (our client ↔ our mock/server helpers) the loop is verified end-to-end.
2. **`MCPError extends Error`** — `instanceof Error`, stacks, readable `String(e)`;
   fields unchanged; aborts now classify as `kind: "cancelled"` (previously a dead union
   member).
3. **Codegen result types** — `outputSchema` → typed `structuredContent` on `result`
   (non-optional per spec), same schema→TS converter; prompt-studio's committed
   `mcp.gen.ts` regenerated with a typed `get-structured-content`.
4. **Cache eviction** — `cache.remove(key)` + `cache.clear({ server?/partition? })`;
   `gcTime` exposed on read/query opts; write-time GC arming so imperative reads no
   longer linger forever (timers unref'd).
5. **HTTP recording** — `mcp-record record --url` (with the hosted-traffic warning);
   `mcp-query contract`/`record` now resolve registry names.
6. **Gate config** — declarative `.mcp.json`-shape upstreams (`{command}`/`{url}`, no SDK
   imports needed in configs) + full dependency-free validation naming bad keys (the
   `replace`-vs-`replacement` class of typo now throws).
7. **CLI ergonomics** — unknown flags rejected with the known-flag list across every tool
   CLI; one call-spec grammar everywhere (`tool(k: v)` AND `tool:{"k":"v"}`), shared in
   `mcp-contract/src/callspec.ts`; parse errors show both accepted forms.
