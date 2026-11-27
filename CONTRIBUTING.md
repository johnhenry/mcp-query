# Contributing

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets) and the family
publish model: **main is the release branch** (see
[johnhenry/workflows](https://github.com/johnhenry/workflows#the-publish-model-main-is-the-release-branch)).
Each published package (`@johnhenry/mcp-query`, `@johnhenry/mcp-gate`,
`@johnhenry/mcp-query-tanstack`, `@johnhenry/mcp-query-ui`, `@johnhenry/mcp-record`,
`@johnhenry/mcp-contract`) keeps its own independent version line.

1. In a PR that changes a published package, run `npm run changeset`, pick the
   package(s) and bump type, and commit the generated `.changeset/*.md`.
2. When the PR merges, `release.yml` opens or updates a **"chore: version packages"**
   PR that applies the bumps and changelogs for all workspaces.
3. Merging that PR lands the new versions on `main`, and every push to `main` runs the
   publish workflows. Each publishes its own package **only if that version is
   not on npm yet** (`scripts/release.mjs`, behind an `npm view` guard), then creates
   the tag `<package name>@<version>` (e.g. `@johnhenry/mcp-query@0.3.0`) and a GitHub
   Release as by-products.

**Spec calendar check.** Before cutting a release, look at where the spec is: the MCP specification now
ships twice a year, generally on the last Tuesday of March and September (SEP-3398), and the next revision
targets 2027-03-30. A release notes entry that touches protocol behaviour (new lint rules, an `--era`
default, deprecations) should say which revision it was written against, and a feature that SEP-2596 lists
as Deprecated (HTTP+SSE, sampling, roots, logging; earliest removal on or after 2027-07-28) should not be
newly adopted.

**One-time repository requirement.** `changesets/action` opens the Version Packages PR
with `GITHUB_TOKEN`, which needs both `permissions: pull-requests: write` on the job
(already set in the workflow) and the repo setting *Settings > Actions > General >
"Allow GitHub Actions to create and approve pull requests"*; without it the run fails at
`creating pull request`. Check / enable with
`gh api repos/johnhenry/mcp-query/actions/permissions/workflow` and
`gh api -X PUT repos/johnhenry/mcp-query/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.

| Package | Workflow (trusted-publisher filename: do not rename) |
|---------|------------------------------------------------------|
| `@johnhenry/mcp-query` | `release.yml` (also runs the Changesets version PR) |
| `@johnhenry/mcp-gate` | `release-gate.yml` |
| `@johnhenry/mcp-query-tanstack` | `release-mcp-query-tanstack.yml` |
| `@johnhenry/mcp-query-ui` | `release-mcp-query-ui.yml` |
| `@johnhenry/mcp-record` | `release-mcp-record.yml` |
| `@johnhenry/mcp-contract` | `release-mcp-contract.yml` |

npm trusted publishing trusts one workflow filename per package, which is why there
are six files instead of one `changeset publish`; `changeset publish` would also pass
`--tag latest`, overriding `publishConfig.tag`.

Nobody creates tags or Releases by hand to cause a publish, and the old prefixed
tags (`query-v*`, `gate-v*`, `mcp-query-tanstack-v*`, bare `v*`) no longer trigger
anything. Existing tags are kept as history; the legacy `v0.*` tags refer to the
pre-rename "mcpq" line, except mcp-query 0.2.0, which is tagged `query-v0.2.0`.

`workflow_dispatch` on each workflow re-runs the same flow (useful if a publish failed
partway through). A push to `main` with no pending version bump publishes nothing.

### A brand-new package

A new package starts at version `0.0.0` with a `minor` changeset, so the Version Packages PR takes it to
`0.1.0`. `scripts/release.mjs` never publishes `0.0.0`. npm trusted publishing cannot create a package
(`npm trust` requires it to exist already), so the first publish is a one-time manual step by the
maintainer, followed by `npm trust github` for the package's workflow file; see each package's README
"Releasing" section (`mcp-query-ui`, `mcp-record`, `mcp-contract`). `@johnhenry/mcp-record` depends on
`@johnhenry/mcp-contract`, so publish contract first.

### Dist-tags

`scripts/release.mjs` uses a package's `publishConfig.tag` if set, else `rc` for
prerelease versions, else `latest`. `@johnhenry/mcp-query-tanstack` declares
`"tag": "rc"`, so it stays off `latest` until it is a real stable release; remove that
field then.

To check what a release would do without publishing:
`npm run release -- @johnhenry/mcp-gate --dry-run`.
