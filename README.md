# mcp-query ecosystem

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fmcp-query.svg)](https://www.npmjs.com/package/@johnhenry/mcp-query)
[![CI](https://github.com/johnhenry/mcp-query/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/mcp-query/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fmcp-query.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/agent-query](https://opensource.johnhenry.me/agent-query/)

A data-layer ecosystem for the **Model Context Protocol** — a reactive client and the
governance, testing, and fixture tooling built around it: the TanStack-Query-of-MCP move,
plus the gateway, schema-drift, and mocking tooling a production data layer needs.

The `mcp-query` client's reactive core is the MCP adapter of
[`@johnhenry/agent-query-core`](https://github.com/johnhenry/agent-query-core), the shared
engine behind siblings [`@johnhenry/a2a-query`](https://github.com/johnhenry/a2a-query) (A2A)
and [`@johnhenry/acp-query`](https://github.com/johnhenry/acp-query) (ACP).

This repo is an npm-workspaces monorepo. The packages share one core (`mcp-query`) and
compose along a clean seam (an interceptor chain + a transport tap), so each does one job
and they stack:

```
                          ┌─────────────────────────────────────────────┐
 your app / agent host ──▶│                 mcp-query                    │──▶ MCP servers
                          │   reactive client · cache · codegen · core   │
                          └─────────────────────────────────────────────┘
                                              ▲
      ┌──────────┬──────────┬──────────┬───────┴──┬──────────┬──────────┐
 ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
 │ mcp-gate│ │contract│ │  lint  │ │  docs  │ │  bench │ │ record │
 │ govern  │ │ guard  │ │ lint   │ │generate│ │ measure│ │ freeze │
 │ runtime │ │ drift  │ │ quality│ │ref docs│ │ latency│ │ traffic│
 └─────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
              └──────── share capture / connect (the surface) ───────┘
```

## Contents

- [Which package do I want?](#which-package-do-i-want)
- [Packages](#packages)
- [Apps](#apps)
- [How they relate](#how-they-relate)
- [Cross-package examples](#cross-package-examples)
- [The `mcp-query` CLI](#the-mcp-query-cli)
- [Develop](#develop)
- [Status](#status)
- [Adding a new package](#adding-a-new-package)
- [Security model](#security-model)
- [Family](#family)
- [License](#license)

## Which package do I want?

| I want to... | Start with |
|---|---|
| Consume MCP servers from an app or backend with a real data layer (cache, hooks, codegen) | [`mcp-query`](./packages/mcp-query) — everything else in this repo builds on it |
| Drive multiple registered MCP servers from one CLI command | [`cli`](./packages/cli) — the unified `mcp-query` binary, plus a server registry |
| Front MCP servers behind a governed runtime choke point (auth, DLP redaction, rate-limit, audit) | [`mcp-gate`](./packages/mcp-gate) |
| Catch breaking MCP server drift in CI before it ships | [`mcp-contract`](./packages/mcp-contract) |
| Enforce a quality bar on an MCP server you're authoring | [`mcp-lint`](./packages/mcp-lint) |
| Generate always-current reference docs for an MCP server | [`mcp-docs`](./packages/mcp-docs) |
| Track an MCP server's performance or gate CI on a latency budget | [`mcp-bench`](./packages/mcp-bench) |
| Get a server's real recorded output in tests/demos, fast, offline, and frozen | [`mcp-record`](./packages/mcp-record) |
| Feed mcp-query's cache into a TanStack Query app | [`mcp-query-tanstack`](./packages/mcp-query-tanstack) |

## Packages

| Package | What it does | When you reach for it |
|---|---|---|
| **[@mcp-query/cli](packages/cli)** | The unified **`mcp-query`** CLI: one entry point over every tool below (`mcp-query lint`/`docs`/`bench`/…), **plus a server registry** (`mcp-query add`, honoring the `.mcp.json`/`mcpServers` standard) and **client verbs** (`mcp-query tools`/`call`/`read`) to drive any registered server. | You want **one command** for the whole toolkit and to call your MCP servers by name from the terminal. |
| **[mcp-query](packages/mcp-query)** | The reactive, cached, embeddable MCP **client** (`npm install @johnhenry/mcp-query`): TanStack-Query-style document cache, RTK-Query tags, LSP-client lifecycle, React hooks, codegen, an interceptor chain, and optional server-side modules (gateway, metrics, OTel, sessions, Redis L2). | You're **consuming** MCP servers from an app or backend and want a real data layer, not raw SDK calls. |
| **[@johnhenry/mcp-gate](packages/mcp-gate)** | A config-driven **security/policy proxy**. Fronts many upstreams as one governed endpoint: declarative authorization, DLP redaction, rate-limit, circuit-breaking, audit. | You're handing MCP servers to an agent and need a **runtime choke point** — allow/deny, scrub secrets, log everything. |
| **[@mcp-query/contract](packages/mcp-contract)** | **Contract testing / drift detection.** Pin a server's capability surface, then fail CI when a live server changes incompatibly (with proper input/output variance). The dual of codegen. | You generated/wrote code against an MCP server and want CI to **catch breaking drift** before it ships. |
| **[@mcp-query/lint](packages/mcp-lint)** | **Quality lint** (ESLint for MCP). Check a single surface against design rules — descriptions, annotations, typed inputs, naming — and gate CI on it. | You're **authoring** an MCP server and want a quality bar enforced in CI. |
| **[@mcp-query/docs](packages/mcp-docs)** | **Reference docs** (Redoc for MCP). Render Markdown docs from a live server or a contract: tool arg tables, annotation badges, resources, prompts. | You want **always-current reference docs** for an MCP server, generated not hand-written. |
| **[@mcp-query/bench](packages/mcp-bench)** | **Benchmarking.** Latency (p50/p95/p99) + throughput per tool, with perf budgets that fail CI. Local or hosted servers. | You want to **track an MCP server's performance** or gate on a latency budget. |
| **[@mcp-query/record](packages/mcp-record)** | **Record / replay** (VCR for MCP). Capture real server traffic to a cassette, replay it offline as a deterministic mock. | Your tests/demos need a server's **real output** but fast, offline, and frozen. |

## Apps

Reference applications that prove you can build real product UIs on MCP — each chosen to
exploit a different MCP-native capability REST/GraphQL lack. They share a spine (`apps/shared`:
the WS proxy, transport, OAuth, schema-form, and React glue).

| App | What it shows | Stack |
|---|---|---|
| **[inspector](apps/inspector)** | Protocol **debugger** — raw message log, manual sampling, OAuth stepper, cache view | Web Components |
| **[console](apps/console)** | **Capability discovery** — a polished operator UI auto-generated from *any* server's tools/resources/prompts | Web Components |
| **[ops-cockpit](apps/ops-cockpit)** | **Aggregation + live tiles** — a NOC dashboard over many servers, reactive on health + `list_changed` | React |
| **[approvals](apps/approvals)** | **Human-in-the-loop** — agent sampling/elicitation proposals approved/edited in a queue, on the `InteractionBroker` | React |
| **[notebook](apps/notebook)** | **Subscriptions** — a notes UI where agent and app share one live view via `resources/subscribe` | React |
| **[composer](apps/composer)** | **Tools as *input*** — a chat where the *user* drives MCP tools to assemble grounded input (the inverse of agentic tool use), with a pluggable model picker via [aimatey](https://github.com/johnhenry/aimatey) | React |
| **[prompt-studio](apps/prompt-studio)** | **Prompts as a product surface** — run server prompts with live `completion/complete` typeahead (incl. dependent completions), expand resource templates into subscribed reads, over codegen-typed hooks | React |
| **[switchboard](apps/switchboard)** | **One governed endpoint, many tenants** — an `@johnhenry/mcp-gate` sidecar fronting local + live remote upstreams, an interceptor trace waterfall, and per-tenant cache partitions via `client.scope()` | React |

> **Moved:** `socialgpt-studio` was removed from this repo. It now lives in the Scrollmark platform monorepo as `socialgpt/studio`, merged with the Atlas content-analysis views.

Browser apps reach stdio servers through `apps/shared`'s WebSocket proxy (the `dev` script runs
it alongside Vite); the React apps dogfood `mcp-query`'s React hooks, the Web-Components apps the
framework-agnostic core.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="apps/ops-cockpit"><img src="apps/ops-cockpit/screenshots/grid.png" alt="ops-cockpit"></a><br>
      <b><a href="apps/ops-cockpit">ops-cockpit</a></b> — a NOC dashboard with live health tiles over many servers at once.
    </td>
    <td width="50%" valign="top">
      <a href="apps/prompt-studio"><img src="apps/prompt-studio/screenshots/runner.png" alt="prompt-studio"></a><br>
      <b><a href="apps/prompt-studio">prompt-studio</a></b> — server prompts as a product surface, with live completions.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="apps/inspector"><img src="apps/inspector/screenshots/messages.png" alt="inspector"></a><br>
      <b><a href="apps/inspector">inspector</a></b> — a protocol debugger with the raw JSON-RPC message log.
    </td>
    <td width="50%" valign="top">
      <a href="apps/composer"><img src="apps/composer/screenshots/reply.png" alt="composer"></a><br>
      <b><a href="apps/composer">composer</a></b> — tools as <i>input</i>: a user-driven, grounded chat.
    </td>
  </tr>
</table>

> Each app's README has a full Screenshots section.

## How they relate

- **One core, composable seams.** `mcp-gate` is just `mcp-query`'s `MCPClient` behind its
  `createGateway`, with an interceptor stack. `mcp-record` taps the same `instrumentTransport`
  seam the devtools use. `mcp-contract`'s mock and `mcp-record`'s replay both build on the
  shared `MockMCPServer`.
- **One capture, four uses.** `mcp-contract` captures a server's surface; `mcp-lint` and
  `mcp-docs` reuse that same `captureContract` — to *grade* the surface and to *document* it.
  Pin it (contract), lint it (lint), document it (docs).
- **contract vs lint:** contract is **relative** (did it change incompatibly between two
  versions?); lint is **absolute** (is this one version well-designed?). Run both in CI.
- **contract vs record:** a *contract* pins the **shape** (schemas/annotations) to catch drift;
  a *cassette* freezes the **real results** for offline replay. Use both — contract in CI,
  cassettes in tests.

## Cross-package examples

The [`examples/`](./examples) directory at the repo root demonstrates those seams end to end —
each one numbered, runnable, and offline (in-process mock server, no subprocess, no keys):

```bash
npm run examples     # builds mcp-query + mcp-gate + mcp-query-tanstack, runs all six
npm run example:01   # client + in-process mock server (the pair everything else wraps)
npm run example:02   # gate the client: policy denial, DLP redaction, audit
npm run example:03   # record a session to a cassette, replay it offline
npm run example:04   # contract drift: capture, "redeploy", classify breaking vs compatible
npm run example:05   # the pipeline: cassette as upstream, gate in front, governed offline replay
npm run example:06   # the TanStack bridge driven headless in Node
```

Per-package deep dives live in [`packages/mcp-query/examples`](./packages/mcp-query/examples)
(8 numbered examples) plus smaller sets in mcp-gate, mcp-record, and mcp-contract.

## The `mcp-query` CLI

One entry point over the whole toolkit, a server registry, and a terminal MCP client:

```bash
# register a server once (stdio or hosted; honors ~/.mcp-query/servers.json + project .mcp.json)
mcp-query add everything --command npx --args "-y @modelcontextprotocol/server-everything"
mcp-query add linear https://mcp.linear.app/mcp        # hosted
mcp-query login linear                                  # browser OAuth (DCR+PKCE), token cached + auto-refreshed
mcp-query servers                                       # list them
mcp-query import claude                                 # pull servers from Claude/Cursor/VS Code configs

# drive any registered server (by name) from the terminal
mcp-query tools everything                              # list tools as typed signatures
mcp-query call everything echo --message hi             # flag style …
mcp-query call everything 'get-sum(a: 2, b: 40)'        # … or function-call style (coerced by inputSchema)
mcp-query read everything file:///x   ·   mcp-query ping everything
mcp-query session everything                            # interactive REPL on ONE live connection
mcp-query call --daemon everything echo --message hi    # keep-alive daemon reuses the connection
mcp-query daemon status   ·   mcp-query daemon stop          # across invocations (great for stateful stdio servers)

# every tool is a verb — and accepts a registered name
mcp-query lint everything   ·   mcp-query docs linear --out API.md   ·   mcp-query bench everything --call echo:'{}'
mcp-query contract snapshot everything --out api.json   ·   mcp-query gate ./gate.config.ts
```

`.mcp.json`/`mcpServers` configs from Claude, Cursor, and VS Code are read natively (no secrets
stored — OAuth lives in `~/.mcp-query/oauth/`). The individual `mcp-*` bins still work standalone.

## Develop

```bash
npm install                 # install all workspaces

npm test                    # run every workspace's test suite
npm run build               # build the publishable mcp-query package (dist/)
npm run typecheck           # typecheck all workspaces

# work in one package
npm test -w @johnhenry/mcp-query
npm test -w @johnhenry/mcp-gate
npm run dev -w @mcp-query/inspector
```

In this monorepo the satellite packages consume `mcp-query` directly from its TypeScript
**source** (`packages/mcp-query/src`) for a zero-build dev loop; only `mcp-query` itself
emits a `dist/` for publishing.

## Status

`main` is pre-2026-07-28: `mcp-query` is at `0.0.1`, `latest` on npm. The gate /
contract / lint / docs / bench / record packages and the inspector are MVPs
(`private`) tracking it. See each package's README for specifics, and the note
above for what's landing next.

## Adding a new package

The best real worked example in this repo's own history is **"one capture, four
uses"** (see [How they relate](#how-they-relate) above): `mcp-contract` captures
a server's capability surface via its exported `captureContract` function, and
both `mcp-lint` and `mcp-docs` import that exact function to grade the surface
and to document it, rather than each re-implementing their own capture step.
That is the shape every new package in this repo should aim for — reuse an
existing seam (the interceptor chain, `captureContract`, `instrumentTransport`)
instead of inventing a parallel one.

**Smallest: a new interceptor, CLI verb, or export on an existing package.**
`mcp-gate`'s own interceptor chain (`packages/mcp-gate/src/index.ts`) is just a
`RequestInterceptor[]` array; adding a new cross-cutting concern (say, a new
redaction strategy) is one more entry in that array reusing the exact same
`Operation`/`next` shape every other interceptor already uses. No new package,
no new `package.json`, no new workspace member — the whole cost is the
interceptor itself. The test that decides whether this is enough or whether you
need a genuinely new package: **does this need its own npm identity** (a
separately versioned, separately installable artifact under `@johnhenry/*`), or
its own CLI binary distinct from the umbrella `mcp-query` CLI? If no, extend an
existing package.

**A genuinely new package.** Adding one under `packages/` (or `apps/`) means all
of the following, not just `npm init`:

1. **`package.json` + `tsconfig.json`** matching an existing package's shape —
   copy `packages/mcp-lint`'s or `packages/mcp-record`'s as a starting point
   (both are private/internal, the more common case; `packages/mcp-gate`'s if
   the new package will actually publish under the `@johnhenry` scope).
2. **No `workspaces` edit needed.** Root `package.json`'s `workspaces` field is
   the globs `packages/*` and `apps/*`, not a per-package list — a new directory
   under either is picked up automatically by `npm install`.
3. **`README.md`** with the badge row, `## Family` section, and provenance note
   per the family standard (only meaningful once the package is actually
   published — an unpublished internal package's README can skip the npm/CI
   badges and just link back to the root README).
4. **`CHANGELOG.md` entry** — either the package's own, or a bullet under the
   root `CHANGELOG.md`'s next `## Unreleased` section, grouped under a bold
   `**@johnhenry/<name>**` line per the monorepo convention.
5. **`"engines": { "node": ">=22.0.0" }`** — only if the package will actually
   be published under the `@johnhenry` scope. Phase 0 of this repo's own
   ecosystem-cohesion pass added `engines.node` only to the three packages that
   are genuinely published (`mcp-query`, `mcp-gate`, `mcp-query-tanstack`) plus
   root, deliberately leaving the private internal-tooling packages (`cli`,
   `mcp-bench`, `mcp-contract`, `mcp-docs`, `mcp-lint`, `mcp-record`) without
   it — don't add it to a package that isn't shipping to npm.
6. **Root `examples`/`build:examples` scripts** — if the new package
   participates in the root [cross-package examples](#cross-package-examples),
   add its build to `build:examples` (which today builds `mcp-query`,
   `mcp-gate`, and `mcp-query-tanstack` — everything the root examples import
   from `dist`) and, if it ships its own numbered example, a new
   `example:NN`/table row.

See [`AGENTS.md`](AGENTS.md)'s [`## New-package definition of
done`](AGENTS.md#new-package-definition-of-done) for the same checklist phrased
for an agent mid-task; that section links back here rather than duplicating it.

## Security model

`@johnhenry/mcp-gate` is this repo's real trust boundary — a config-driven
security/policy proxy that fronts many upstream MCP servers as one governed
endpoint. It is not a sandbox for arbitrary code and does not isolate the
upstream servers' own processes from each other or from the host; what it does
guarantee is scoped to the requests that pass through its interceptor chain.

**What mcp-gate guarantees:**

- **Declarative allow/deny policy is enforced on every call, not just at
  discovery time.** `compilePolicy()` compiles `GatePolicyRules.allow`/`deny`
  globs into an `authorize()` interceptor wired first in the interceptor chain
  (after tenant-partition resolution); a denied id never reaches an upstream.
  `deny` takes precedence over `allow` when both match the same id, and
  `denyDestructive` denies any tool flagged `destructiveHint` — there is no
  bypass flag that skips policy once one is configured
  (`packages/mcp-gate/src/config.ts`).
- **Name-denied tools/resources/prompts are hidden from discovery, not just
  blocked on call.** `policyListFilter()` derives a list-time filter from the
  same declarative policy and wires it as `createGateway`'s `filter` option —
  but only for declarative (`GatePolicyRules`) policies; a function policy
  makes `policyListFilter()` return `undefined`, so it is enforced call-time
  only and discovery stays unfiltered (`packages/mcp-gate/src/config.ts`).
- **DLP redaction rewrites matching substrings in every result before it
  reaches the caller.** `redact()`'s `redactDeep` walks tool content, resource
  text, and structured output recursively and replaces every regex match; it
  is wired as the last interceptor in the chain, so it runs after the upstream
  call has already resolved (`packages/mcp-gate/src/redact.ts`).
- **Rate-limiting and circuit-breaking are keyed per `(server, tenant)`, not
  globally.** `tenantKey(op)` is `` `${op.peer}::${op.context?.partition ?? ""}` ``;
  with no `partitionFrom` configured every key collapses to `` `${server}::` ``,
  so an unconfigured gate behaves like mcp-query's own un-tenant-aware default
  rather than silently under-protecting one tenant because of another
  (`packages/mcp-gate/src/index.ts`).
- **A malformed config fails before anything connects.** `createGate()` calls
  `validateGateConfig(config)` first — a typo'd key (e.g. `replace` vs
  `replacement`) throws instead of being silently ignored
  (`packages/mcp-gate/src/config.ts`, `validate.ts`).

**What is still yours:**

- **The audit sink is an observability hook, not a veto.** `GateConfig.audit`
  fires after the operation has already settled and is never awaited —
  `@johnhenry/mcp-query`'s `MCPClient.run()` invokes it fire-and-forget, by
  documented design (see `GateConfig.audit`'s own TSDoc; investigated and
  closed as intentional in mcp-query #22). A slow, failing, or unreachable
  audit sink cannot block or reject a call — use `policy`, not `audit`, for
  enforcement.
- **`gate.close()` is not guaranteed to reap every spawned stdio
  `ChildProcess`.** Its promise can resolve while `ChildProcess` handles from
  earlier `addUpstream`/`removeUpstream` cycles are still alive (mcp-query
  #23, open). Don't assume the process tree is clean just because `close()`
  resolved — verify with `process._getActiveHandles()` in anything
  process-lifecycle-sensitive.
- **CLI OAuth tokens are cached in plain JSON, not hardened at rest.**
  `~/.mcp-query/oauth/<host>.json` stores client registration and
  access/refresh tokens as unencrypted JSON via a plain `writeFileSync`, with
  no restricted file mode set (`packages/mcp-contract/src/oauth.ts`). Anyone
  who can read that path as the same OS user can read the tokens — treat the
  cache like any other unencrypted credential file on disk; neither mcp-gate
  nor mcp-query protect it.
- **A per-upstream `getToken()` resolves one credential for the whole
  connection, not per call or per tenant.** A single upstream URL's bearer
  token can't vary by tenant on its own; for a token that must differ per
  tenant on the same upstream, provision one connection per
  `(upstream, partition)` via `Gate.addUpstream`, each with its own
  `getToken` (documented on `HttpUpstreamSpec.getToken`,
  `packages/mcp-gate/src/config.ts`).

## Family

| Protocol | Library | Status |
|---|---|---|
| MCP | `@johnhenry/mcp-query` (this package) | published — the MCP adapter of agent-query-core |
| A2A | [`@johnhenry/a2a-query`](https://github.com/johnhenry/a2a-query) | published — sibling protocol adapter |
| ACP | [`@johnhenry/acp-query`](https://github.com/johnhenry/acp-query) | published — sibling protocol adapter |
| shared engine | [`@johnhenry/agent-query-core`](https://github.com/johnhenry/agent-query-core) | published — the reactive core mcp-query, a2a-query, and acp-query all build on |

## License

[MIT](LICENSE)
