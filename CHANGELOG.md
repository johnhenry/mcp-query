# Changelog

Monorepo-level changelog — package-level detail lives with each package.

## [Unreleased]

### Added

- Cross-package examples at the repo root (`examples/01`–`06`, `npm run example:NN` / `npm run examples`): client + mock server, gate governance (policy/redact/audit), record → replay, contract drift, the gated-replay pipeline composing record + gate + client, and the TanStack bridge driven headless. All offline, in-process, following the family's numbered-example convention.
- CI: a root-examples smoke step (`npm run examples`) after the test/coverage/publish-smoke gates.
- `build:examples` root script (builds `mcp-query`, `mcp-gate`, and `mcp-query-tanstack` — everything the root examples import from `dist`).
- Root README: a "Cross-package examples" section indexing the new examples and the per-package sets.
- This changelog.

## 2026-08-23 — the agent-query family rename

- **npm handles renamed to match the GitHub repo names** (`mcpq`/`a2aq`/`acpq` → `*-query`): this repo's published packages became `@johnhenry/mcp-query` and `@johnhenry/mcp-query-tanstack` (formerly `@johnhenry/mcpq`, `@johnhenry/mcpq-tanstack`); versioning restarted at `0.0.0`. `@johnhenry/mcp-gate` kept its name and its own version line (`0.2.x`). The rename went deeper than the package names: CLI binaries, cache namespaces, and storage keys changed with it — code written against the old packages needs updating, not just its `package.json`.
- Release workflows made idempotent (token guard, concurrency, `publishConfig`).
