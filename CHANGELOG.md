# Changelog

Monorepo-level changelog — package-level detail lives with each package.

## Unreleased

- **Node 26 is the floor** (`engines.node` `>=26.0.0`, CI and release on 26,
  `.nvmrc` 26), moved in lockstep across the `*-query` family
  (agent-query-core, a2a-query, acp-query, mcp-query), the family-wide
  standard. Node 26's npm can also publish through npm trusted publishing.

### Fixed

- `@johnhenry/mcp-query` (peer) and `@johnhenry/mcp-gate` (dependency): `@modelcontextprotocol/client` and `@modelcontextprotocol/server` widened from the exact `2.0.0` to `^2.0.0`, so consumers on any 2.x SDK install without `ERESOLVE` peer warnings or a duplicate SDK copy. The suite passes on 2.0.0 and the latest 2.x (2.3.1); a new `sdk-matrix` CI job runs `mcp-query` and `mcp-gate` against both. The private workspace packages and apps use the same `^2.0.0` range. [Issue #42](https://github.com/johnhenry/mcp-query/issues/42)

### Added

- `@johnhenry/mcp-gate@0.3.0`: first-class human approval. `GatePolicyRules.approve?: string[]` (glob ids that need sign-off), function policies may return `"approve"`, and `createGate({ approval: { broker?, handler?, timeoutMs?, onTimeout? } })` resolves approvals through an `InteractionBroker` (new `gate.approvals`). Fails closed on timeout/handler error/no approval config. New exported types `ApprovalConfig`, `ApprovalRequest`. Requires `@johnhenry/mcp-query@^0.2.0`. [Issue #43](https://github.com/johnhenry/mcp-query/issues/43)
- `@johnhenry/mcp-query@0.2.0`: `AuthzVerdict` gains `"approve"`; `authorize(policy, { onApprove })` (new `AuthorizeOptions`) -- an `"approve"` verdict without `onApprove` is denied. Docs: approval pattern in `docs/human-in-the-loop.md`. [Issue #43](https://github.com/johnhenry/mcp-query/issues/43)

- `@johnhenry/mcp-gate@0.4.0`: `approval.discovery: "visible" | "annotated" | "hidden"` (default `"visible"`, unchanged behavior). `"annotated"` lists `approve`-gated items with `_meta.requiresApproval: true`; `"hidden"` omits them from `tools/list`/`prompts/list`/`resources/list` while a direct call still goes through approval (hiding is not access control). New export `policyListAnnotator`; `policyListFilter` takes an optional `discovery`.
- `@johnhenry/mcp-query@0.2.1`: `GatewayOptions.annotate(server, kind, name)` merges extra `_meta` into listed tools/resources/prompts (list-only). mcp-gate 0.4.0 requires it.

### Changed

- `@johnhenry/mcp-query@0.2.1`: every method taking a server name (`ping`, `setLogLevel`, `complete`, ...) now throws the same `MCPError` as `list*` (`unknown server "x"; configured: a, b`) instead of a bare `Error('Unknown server "x"')`. React capability hooks' `[]` for a not-yet-added server is now documented with its rationale (mcp-query README).
- Release tags are now per package: `query-v<version>` for mcp-query (new), `gate-v*`, `mcp-query-tanstack-v*`. `release.yml` triggers on `query-v*` and, for one more release, the deprecated bare `v*`. mcp-query 0.2.0 is tagged `query-v0.2.0`. See CONTRIBUTING.md.
- `@johnhenry/mcp-query-tanstack@0.0.2`: republish carrying the widened `@johnhenry/mcp-query` peer range (`>=0.0.0 <0.3.0`).
- `@johnhenry/mcp-query@0.2.0`: `MCPClient.listTools/listResources/listResourceTemplates/listPrompts` take an optional server. Omitted, they return the union across all configured servers with each entry tagged `server`; an unknown server name now **throws** an `MCPError` (`unknown server "x"; configured: a, b`) instead of silently returning `[]`. The React capability hooks still return `[]` for a not-yet-added server. [Issue #41](https://github.com/johnhenry/mcp-query/issues/41)
- `@johnhenry/mcp-query-tanstack`: peer range on `@johnhenry/mcp-query` widened to `>=0.0.0 <0.3.0` (not republished).

A real version/date wasn't invented for this section — packages in this
monorepo version independently and a root-level version number would be
fictional; see each package's own CHANGELOG (where one exists) for its actual
released version history.

### Added

- Cross-package examples at the repo root (`examples/01`–`06`, `npm run example:NN` / `npm run examples`): client + mock server, gate governance (policy/redact/audit), record → replay, contract drift, the gated-replay pipeline composing record + gate + client, and the TanStack bridge driven headless. All offline, in-process, following the family's numbered-example convention. [PR #28](https://github.com/johnhenry/mcp-query/pull/28)
- CI: a root-examples smoke step (`npm run examples`) after the test/coverage/publish-smoke gates. [PR #28](https://github.com/johnhenry/mcp-query/pull/28)
- `build:examples` root script (builds `mcp-query`, `mcp-gate`, and `mcp-query-tanstack` — everything the root examples import from `dist`). [PR #28](https://github.com/johnhenry/mcp-query/pull/28)
- Root README: a "Cross-package examples" section indexing the new examples and the per-package sets, plus a docs-site link. [PR #29](https://github.com/johnhenry/mcp-query/pull/29)
- This changelog. [PR #28](https://github.com/johnhenry/mcp-query/pull/28)

### Fixed

- `@johnhenry/mcp-gate@0.2.2`: the package entry no longer statically imports the Node stdio transport, so `compilePolicy`/`redact`/`validateGateConfig`/`policyListFilter` now load and run in a browser bundle (Vite/webpack/esbuild). `resolveUpstream`'s stdio-spawning code (which genuinely needs Node's `cross-spawn`/`node:stream`) moved to its own module, reachable only through the package's new `browser` export condition split (`.` resolves to a Node-only `dist/index.js` by default, or a pure `dist/index.browser.js` under the `browser` condition); `createGate`/`resolveUpstream` are unaffected in Node. [Issue #37](https://github.com/johnhenry/mcp-query/issues/37)
- `@johnhenry/mcp-gate@0.2.3`: the `browser` export condition's *types* now actually follow it too. `exports["."]` previously listed `types` (unconditional, →&nbsp;`dist/index.d.ts`) before `browser` (→&nbsp;`dist/index.browser.js`), so a bundler's build resolved the browser JS while TypeScript kept resolving the Node `.d.ts` — a browser project type-checked `createGate`/`resolveUpstream`/`Gate`/`CircuitOpenError` (all Node-only, spawn upstream processes) and only failed at bundle time. `browser` is now its own nested condition with a matching `types` (→&nbsp;`dist/index.browser.d.ts`, already emitted by the existing build — just unwired) alongside its `default`, so a browser resolver gets the browser-safe surface for both JS and types, and Node keeps the full one. Verified with a real `tsc --moduleResolution bundler --customConditions browser` consumer (browser-safe subset type-checks, `createGate` correctly does not) and a real esbuild `--platform=browser` bundle (resolves `dist/index.browser.js`, pulls in neither `cross-spawn` nor `node:stream`). [Issue #39](https://github.com/johnhenry/mcp-query/issues/39)
- `@johnhenry/mcp-query-tanstack@0.0.1`: `peerDependencies["@johnhenry/mcp-query"]` was pinned to the exact string `0.0.0` (a leftover from the pre-1.0-caret issue #35 fixed for `mcp-gate`'s *dependency* but never republished here), so it could never be installed alongside the currently-published `@johnhenry/mcp-query@0.1.0` without an npm peer-conflict warning. Widened to `>=0.0.0 <0.2.0` — nothing in `mcp-query-tanstack`'s code depends on any API that changed between those two releases (the 0.1.0 bump was itself only the caret-quirk fix, no API change), so this is the accurate compatible range, not just a wider one. Verified: `npm install`ing this package's tarball alongside a real `@johnhenry/mcp-query@0.1.0` now produces zero peer warnings and a single deduped copy in `npm ls @johnhenry/mcp-query`, versus reproducible `ERESOLVE`-style conflict warnings under the old exact pin. [Issue #39](https://github.com/johnhenry/mcp-query/issues/39)

## MCP 2026-07-28 adopted (2026-07-28)

- Adopted the finalized MCP 2026-07-28 revision (v2 SDK, dual-era support, the `versions` negotiation sugar) via [PR #17](https://github.com/johnhenry/mcp-query/pull/17), merged the same day the spec finalized. `main` and the npm `latest` tag speak the new revision going forward; the pre-merge `rc` dist-tag preview is superseded.

## The agent-query family rename (2026-08-23)

- **npm handles renamed to match the GitHub repo names** (`mcpq`/`a2aq`/`acpq` → `*-query`): this repo's published packages became `@johnhenry/mcp-query` and `@johnhenry/mcp-query-tanstack` (formerly `@johnhenry/mcpq`, `@johnhenry/mcpq-tanstack`); versioning restarted at `0.0.0`. `@johnhenry/mcp-gate` kept its name and its own version line (`0.2.x`). The rename went deeper than the package names: CLI binaries, cache namespaces, and storage keys changed with it — code written against the old packages needs updating, not just its `package.json`. [PR #27](https://github.com/johnhenry/mcp-query/pull/27)
- Release workflows made idempotent (token guard, concurrency, `publishConfig`). [PR #26](https://github.com/johnhenry/mcp-query/pull/26)
