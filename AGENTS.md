# Agent playbook

npm workspaces monorepo, 10 packages under `packages/` (`cli`, `mcp-bench`,
`mcp-contract`, `mcp-docs`, `mcp-gate`, `mcp-lint`, `mcp-query`,
`mcp-query-tanstack`, `mcp-query-ui`, `mcp-record`) plus reference apps under `apps/`, Node
`>=26.0.0` (the family floor; CI and `.nvmrc` agree, and the `*-query` repos
move together), vitest
for tests in every package, Turborepo (`turbo.json`) orders `build`/`typecheck`/`test` by workspace
dependency, so a package that depends on another workspace package by name
(`mcp-record` -> `mcp-contract`) gets that dependency built first without any
extra CI step.
`@johnhenry/mcp-query`, `@johnhenry/mcp-gate`, `@johnhenry/mcp-query-tanstack`,
`@johnhenry/mcp-query-ui`, `@johnhenry/mcp-record` and `@johnhenry/mcp-contract`
are published to npm under the `@johnhenry` scope — everything else under
`packages/*` (`cli`, `mcp-lint`, `mcp-docs`, `mcp-bench`) is `private` internal
tooling consumed only inside this repo. The one fact that most changes how
you work here: `packages/mcp-query`'s `package.json` `exports` map (`.`,
`./server`, `./testing`, etc.) all resolve to its `dist/`, so **every other
workspace that imports `@johnhenry/mcp-query` by name needs `mcp-query`
built first** — its own typecheck/test do not, but everyone else's do. This
is why `ci.yml`'s very first step after install is "Build mcp-query", before
anything else; skipping it locally produces typecheck/test failures that
look like real bugs but are actually a stale-or-missing `dist/`. `mcp-gate`
and `mcp-query-tanstack` also build their own `dist/`, but only for their
own publishing — nothing else in the workspace depends on those builds
existing first.

`CLAUDE.md` in this directory is a symlink to this file.

## Workspace structure and build order

`package.json`'s `workspaces` field is the globs `packages/*` and `apps/*` —
not a per-package list — so there is no declared dependency order to keep in
sync; npm and the build tooling resolve real dependencies from each
package's own `package.json`. The one ordering constraint that matters in
practice is the one above: `mcp-query` builds before anything else typechecks
or tests.

| Package | Role |
| --- | --- |
| [`mcp-query`](packages/mcp-query) | The reactive, cached, embeddable MCP client — the core every other package in this repo builds on. Publishes as `@johnhenry/mcp-query`. |
| [`cli`](packages/cli) | The unified `mcp-query` CLI: one entry point over every tool below, plus a server registry (`mcp-query add`) and client verbs (`tools`/`call`/`read`). Internal, unpublished (`@mcp-query/cli`). |
| [`mcp-gate`](packages/mcp-gate) | Config-driven security/policy proxy: declarative authorization, DLP redaction, rate-limit, circuit-breaking, audit. Publishes as `@johnhenry/mcp-gate`. |
| [`mcp-contract`](packages/mcp-contract) | Contract testing / drift detection: pins a server's capability surface, fails CI on incompatible drift. Publishes as `@johnhenry/mcp-contract`. |
| [`mcp-lint`](packages/mcp-lint) | Quality lint for MCP servers (design rules, annotations, naming). Internal, unpublished (`@mcp-query/lint`). |
| [`mcp-docs`](packages/mcp-docs) | Generates reference docs from a live server or a contract. Internal, unpublished (`@mcp-query/docs`). |
| [`mcp-bench`](packages/mcp-bench) | Latency/throughput benchmarking with CI perf budgets. Internal, unpublished (`@mcp-query/bench`). |
| [`mcp-record`](packages/mcp-record) | Record/replay (VCR for MCP): capture real traffic, replay offline. Publishes as `@johnhenry/mcp-record` (with a browser-safe entry). |
| [`mcp-query-tanstack`](packages/mcp-query-tanstack) | TanStack Query bridge over `mcp-query`'s cache. Publishes as `@johnhenry/mcp-query-tanstack`. |
| [`mcp-query-ui`](packages/mcp-query-ui) | MCP Apps (SEP-1865) host over the `MCPClient`. Publishes as `@johnhenry/mcp-query-ui`. |

`apps/*` are reference UIs proving the packages above on real product
surfaces (see the root README's `## Apps` table); `apps/shared` is their
common spine (WS proxy, transport, OAuth, schema-form, React glue), not a
demo itself.

## The verification loop (before every push)

Build must run before typecheck or test — `mcp-query`'s cross-package
imports resolve through its `dist/`, not its source (see above), so a stale
or missing build produces failures that look like real bugs.

```bash
npm ci
npm run build -w @johnhenry/mcp-query   # must exist before any other workspace typechecks/tests
npm run typecheck                        # tsc --noEmit, every workspace
npm test                                 # vitest run, every workspace
npm run test:coverage                    # mcp-query only
npm run examples                         # rebuilds mcp-query + mcp-gate + mcp-query-tanstack, then runs 01–06
```

CI (`.github/workflows/ci.yml`) runs, in this order: checkout, `npm ci`,
build `mcp-query`, typecheck (all workspaces), test (all workspaces),
coverage (`mcp-query`), a publish smoke step (imports the built entrypoint
and checks `MCPClient` is exported), the root examples smoke step above, then
typecheck + build for each app in `apps/` (`inspector`, `console`,
`ops-cockpit`, `approvals`, `notebook`, `composer`, `prompt-studio`,
`switchboard`). Match that order locally before pushing.

**SDK versions.** The lockfile pins the latest `@modelcontextprotocol/{client,server,core}`
2.x (currently 2.4.0), so `npm ci`, local runs and the `build-test` job exercise the
SDK-gated tests (skills, modern-era tasks, DPoP) and they count toward coverage. The
published packages' ranges stay `^2.0.0`. The `sdk-matrix` job re-installs the floor
(`2.0.0`) and the newest `^2` over that tree and type-checks + tests every published
package (`mcp-query`, `mcp-gate`, `mcp-query-ui`, `mcp-query-tanstack`, `mcp-contract`,
`mcp-record`) and the CLI on both legs. When you change code that touches SDK types,
reproduce a leg locally: `npm ci && npm install --no-save "@modelcontextprotocol/client@2.0.0"
"@modelcontextprotocol/server@2.0.0" "@modelcontextprotocol/core@2.0.0"`, build `mcp-query`,
then `npm run typecheck -w <pkg> ...` and `npm test -w <pkg> ...` (plain `npm test` goes
through turbo, which replays cached results from the other SDK). Bump the lockfile with
`npm update --package-lock-only`; keep `packages/cli` and `apps/switchboard` on the workspace
`@johnhenry/mcp-gate` (`"*"`), since an exact registry pin drags in an old copy that peer-pins
SDK 2.0.0 and keeps two SDK copies in the tree.

A genuinely fresh clone before a release:
`git clone . /tmp/mcp-query-verifyN && cd $_ && npm ci && npm run build -w @johnhenry/mcp-query && npm test`.
This is the only way to catch "works on my checked-out tree" bugs (missing
`files` entries, undeclared deps).

## Repo-specific gotchas

- **`mcp-query` must build before anything else in the workspace typechecks
  or tests.** See the intro paragraph above — this is the single most common
  way a change looks broken locally but is actually a missing `dist/`.
- **The published npm package name doesn't always match the package
  directory.** `packages/cli` is `@mcp-query/cli` (unpublished); `packages/
  mcp-contract` is `@johnhenry/mcp-contract`; `packages/mcp-lint` is
  `@mcp-query/lint`; `packages/mcp-docs` is `@mcp-query/docs`; `packages/
  mcp-bench` is `@mcp-query/bench` (all unpublished). The six published
  packages (`mcp-query`, `mcp-gate`, `mcp-query-tanstack`, `mcp-query-ui`,
  `mcp-record`, `mcp-contract`) all sit under `@johnhenry/` and match their
  directory names. Previously the two renamed packages published as `@johnhenry/mcpq`
  and `@johnhenry/mcpq-tanstack` (CHANGELOG's `2026-08-23` entry).
- **Examples double as a regression suite.** The root `examples/[0-9]*.ts`
  are run by `npm run examples` and by CI's "Root examples smoke" step,
  through the actually-built `dist/` output of `mcp-query`, `mcp-gate`, and
  `mcp-query-tanstack`. A change that breaks one fails CI even if the unit
  suite is green.
- **`gate.close()` doesn't reliably reap every spawned stdio `ChildProcess`**
  (mcp-query #23, open) — don't assume a clean process tree just because its
  promise resolved; see the root README's `## Security model` for the full
  writeup.

## New-package definition of done

See the root README's [`## Adding a new
package`](README.md#adding-a-new-package) section for the full narrative and
numbered checklist (package.json/tsconfig shape, no `workspaces` edit needed
since it's globs, README badge row + `## Family` + provenance, CHANGELOG
entry, `engines.node` only if actually publishing under `@johnhenry`, and
`build:examples`/`examples` root scripts if the package participates in
cross-package examples). This section exists so an agent mid-task has a
one-line pointer; the checklist itself is not duplicated here.

## Releases

Releases use Changesets (`.changeset/`, `npm run changeset`) with the fleet
"main is the release branch" model. Six publish workflows -- `release.yml`
(mcp-query; also runs the changesets/action version PR), `release-gate.yml`,
`release-mcp-query-tanstack.yml`, `release-mcp-query-ui.yml`, `release-mcp-record.yml`, `release-mcp-contract.yml` -- each trigger on push to `main`, publish only
their own package when its version is new (`scripts/release.mjs`), and create the
`<pkg>@<version>` tag + GitHub Release as by-products. **Never rename or merge those
files**: npm trusted publishing trusts one filename per package. `mcp-query-tanstack`
publishes under the `rc` dist-tag via `publishConfig.tag`. Packages version
independently; there is no root version number (root `CHANGELOG.md` deliberately does
not invent one for its `## Unreleased` section; don't "fix" that -- it would be
fictional). See `CONTRIBUTING.md`.
