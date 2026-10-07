# Contributing

## Release tags

Each published package has its own version line and its own tag prefix. Push the tag
after the version bump has merged to `main`; the tag triggers that package's release
workflow, which verifies the tag matches `package.json` and publishes to npm.

| Package | Tag | Workflow |
|---------|-----|----------|
| `@johnhenry/mcp-query` | `query-v<version>` (e.g. `query-v0.2.1`) | `release.yml` |
| `@johnhenry/mcp-gate` | `gate-v<version>` (e.g. `gate-v0.4.0`) | `release-gate.yml` |
| `@johnhenry/mcp-query-tanstack` | `mcp-query-tanstack-v<version>` | `release-mcp-query-tanstack.yml` |

Bare `v<version>` tags are **deprecated** and no longer used for new releases. They are
ambiguous (a stale pre-rename `v0.2.0` once collided with the real mcp-query 0.2.0), so
`release.yml` accepts them for one more release only. The legacy `v0.*` tags in the
history refer to the pre-rename "mcpq" line, except where noted: mcp-query 0.2.0 is
tagged `query-v0.2.0`.

Releases are idempotent (a version already on npm is skipped), and
`workflow_dispatch` on each workflow publishes whatever version is in `package.json`
on the chosen ref.
