# Changelog

Monorepo-level changelog — package-level detail lives with each package.

## Unreleased

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

## MCP 2026-07-28 adopted (2026-07-28)

- Adopted the finalized MCP 2026-07-28 revision (v2 SDK, dual-era support, the `versions` negotiation sugar) via [PR #17](https://github.com/johnhenry/mcp-query/pull/17), merged the same day the spec finalized. `main` and the npm `latest` tag speak the new revision going forward; the pre-merge `rc` dist-tag preview is superseded.

## The agent-query family rename (2026-08-23)

- **npm handles renamed to match the GitHub repo names** (`mcpq`/`a2aq`/`acpq` → `*-query`): this repo's published packages became `@johnhenry/mcp-query` and `@johnhenry/mcp-query-tanstack` (formerly `@johnhenry/mcpq`, `@johnhenry/mcpq-tanstack`); versioning restarted at `0.0.0`. `@johnhenry/mcp-gate` kept its name and its own version line (`0.2.x`). The rename went deeper than the package names: CLI binaries, cache namespaces, and storage keys changed with it — code written against the old packages needs updating, not just its `package.json`. [PR #27](https://github.com/johnhenry/mcp-query/pull/27)
- Release workflows made idempotent (token guard, concurrency, `publishConfig`). [PR #26](https://github.com/johnhenry/mcp-query/pull/26)
