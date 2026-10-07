# Contributing

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets) and the family
publish model: **main is the release branch** (see
[johnhenry/workflows](https://github.com/johnhenry/workflows#the-publish-model-main-is-the-release-branch)).
Each published package (`@johnhenry/mcp-query`, `@johnhenry/mcp-gate`,
`@johnhenry/mcp-query-tanstack`) keeps its own independent version line.

1. In a PR that changes a published package, run `npm run changeset`, pick the
   package(s) and bump type, and commit the generated `.changeset/*.md`.
2. When the PR merges, `.github/workflows/publish.yml` opens or updates a
   **"chore: version packages"** PR that applies the bumps and changelogs.
3. Merging that PR publishes every package whose version is not on npm yet. As a
   by-product, `changesets/action` pushes a git tag (`<package name>@<version>`,
   e.g. `@johnhenry/mcp-query@0.3.0`) and creates a GitHub Release for each package it
   published.

Nobody creates tags or Releases by hand to cause a publish, and the old prefixed
tags (`query-v*`, `gate-v*`, `mcp-query-tanstack-v*`, bare `v*`) no longer trigger
anything. Existing tags are kept as history; the legacy `v0.*` tags refer to the
pre-rename "mcpq" line, except mcp-query 0.2.0, which is tagged `query-v0.2.0`.

Publishing is idempotent: a version already on npm is skipped, so a push to main
with no pending version bump publishes nothing. `workflow_dispatch` on `publish.yml`
re-runs the same flow (useful if a publish failed partway through).

### Dist-tags

`npm run release` (`scripts/release.mjs`) publishes everything at `latest`, except
packages that declare `publishConfig.tag`. `@johnhenry/mcp-query-tanstack` declares
`"tag": "rc"`, so it stays off `latest` until it is a real stable release; remove that
field then. (`changeset publish` itself always passes `--tag latest`, which is why the
script handles tagged packages.) For a repo-wide prerelease series use Changesets'
pre mode: `npx changeset pre enter rc` ... `npx changeset pre exit`.

To check what a release would do without publishing: `npm run release -- --dry-run`.
