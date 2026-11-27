# mcp-lint

**ESLint for MCP servers.** Quality-lint a server's capability surface against a set of
design rules — descriptions, annotations, typed inputs, naming — and gate CI on the result.

It's the complement to [`@johnhenry/mcp-contract`](../mcp-contract): contract checks *drift*
between two versions (*"did it change incompatibly?"*); lint checks *quality* of one
version (*"is this surface well-designed?"*). Both run on the same captured surface.

## Use

```bash
# lint a live server
npx tsx packages/mcp-lint/src/cli.ts \
  --command npx --args "-y @modelcontextprotocol/server-everything"

# …or a pinned contract (mcp-contract snapshot), and be strict in CI
npx tsx packages/mcp-lint/src/cli.ts --contract mcp.contract.json --max-warnings 0

npx tsx packages/mcp-lint/src/cli.ts --list-rules
```

A live server is reached over stdio (`--command`) **or Streamable HTTP** (`--url https://host/mcp`,
with optional `--bearer "$TOKEN"` / repeated `--header "K: V"`). For an **OAuth-protected** host
with no token yet, run `mcp-contract auth --url …` once (browser-consent flow, incl. an
`ssh -L` recipe for remote boxes) — see
[mcp-contract › OAuth-protected servers](../mcp-contract#oauth-protected-servers). The token is
cached and auto-refreshed, so `mcp-lint --url …` then just works.

**`--era auto|legacy`** (default `auto`): a live server is captured with a bounded `server/discover` probe first and
`initialize` as the fallback (a stdio server is started one extra time for the probe); `--era legacy` skips the
probe, and a registered server's pinned `era` applies when the flag is absent. A server that only speaks the 2025
protocol is linted exactly as before. `--probe` always uses `auto` and refuses `--era legacy`, because its rules
observe the `server/discover` handshake. Rules that need fields only a 2026-07-28 capture carries (`cache-hints`) are
**not evaluated** on a legacy-era capture, a pinned legacy contract or one with no recorded era: the output ends with
`cache-hints: not evaluated ...` instead of warning about fields the legacy handshake cannot carry (and `lintContract`
returns them in `result.skipped`).

Exits non-zero on any **error**-level finding, or when warnings exceed `--max-warnings`
(default: unbounded). Disable or escalate rules with `--off a,b` / `--error a,b`.

Example output against `@modelcontextprotocol/server-everything`:

```
  warn   get-env  name implies a read-only action but readOnlyHint is not set  (read-only-annotation)
  warn   get-resource-reference  input "resourceType" has no description  (tool-input-described)
  ~ 0 errors, 9 warnings
```

## Rules

| Rule | Default | Checks |
|---|---|---|
| `tool-description` | **error** | every tool has a non-empty description |
| `tool-input-described` | warn | every tool input property has a description |
| `destructive-annotation` | warn | a `delete`/`remove`/… -named tool sets `destructiveHint` |
| `read-only-annotation` | warn | a `get`/`list`/`read`/… -named tool sets `readOnlyHint` |
| `no-open-input` | warn | input schema isn't `additionalProperties: true` (untyped) |
| `resource-mime-type` | warn | resources declare a `mimeType` |
| `prompt-description` | warn | prompts have a description |
| `naming-consistency` | warn | tool names use a single convention (no kebab+snake mix) |

### 2026-07-28 surface rules

All `warn` by default so existing CI does not break (escalate with `--error a,b`). Each is evaluated from
the captured contract alone, so they stay silent on a contract that did not capture the field they read
(a v1 file, or a server that does not expose it). They need `mcp-contract` format v2.

| Rule | Default | Checks |
|---|---|---|
| `deprecated-feature` | warn | the server declares `logging` (or `sampling` / `roots` if they appear in its capabilities): deprecated by SEP-2577, twelve-month minimum window per SEP-2596 |
| `cache-hints` | warn | on a 2026-07-28 connection, `server/discover` and the list calls (`tools`, `resources`, `resources/templates`, `prompts`) carry `ttlMs` and `cacheScope` (SEP-2549) |
| `tool-name-format` | warn | tool names are 1-128 characters of `A-Z a-z 0-9 _ - .` and unique (SEP-986) |
| `tool-title-icons` | warn | tools set a `title`; icons use `https:`/`data:` URIs, `light`/`dark` themes and `WxH`/`any` sizes (SEP-973) |
| `schema-dialect` | warn | `inputSchema` / `outputSchema` are 2020-12 object schemas: `inputSchema` root is `type: object`, no foreign `$schema`, no array-form `items` / `additionalItems` / `dependencies` (SEP-2106). A boolean or array `outputSchema` is fine |
| `x-mcp-header` | warn | values are valid header tokens (RFC 9110 `1*tchar`), not spelling a reserved `Mcp-Method` / `Mcp-Name` / `Mcp-Param-*` header, case-insensitively unique, on primitive (`string` / `integer` / `boolean`) properties reachable through `properties` keys only (SEP-2243) |
| `skills-manifest` | warn | skills have `name` / `description` frontmatter matching their directory, a manifest that lists `SKILL.md` with digests, at most 512 files / 16 MiB, and `skill://` URIs (SEP-2640) |
| `destructive-needs-confirmation` | warn | ADVISORY: a tool with `destructiveHint: true` whose description and input schema show no confirmation step (no `confirm` / `dryRun` style property, no mention of confirming, approving or previewing). A server may elicit at call time, which a contract cannot show, so expect false positives (spec: human in the loop for sensitive operations, 2026-07-28 server/tools) |
| `x-mcp-file` | warn | EXPERIMENTAL (the `io.modelcontextprotocol/files` draft, no SEP): an `x-mcp-file` argument declares `accept` (media types) and `maxSize` (bytes) |

`cache-hints` only judges the first page of each list and does not see `resources/read` (a capture
does not read resources). `tool-title-icons` flags every tool without a `title`, which is optional in the
spec, so expect it to be the noisiest of the new rules; it stays on by default; turn it off with `--off tool-title-icons` if you do not want it.

### Live-probe rules (`--probe`)

Some checks need a live connection: a second request, or a request that is meant to fail. They are a
separate list (`LIVE_RULES`), only run with `--probe`, never by `lintContract`, and `--probe` together
with `--contract` is an error (a pinned file cannot answer them). In probe mode the connection stays open
after the capture, and the client negotiates with `server/discover` first (falling back to `initialize`).
Findings are tagged `probe` in the output. All `warn`; `--off` / `--error` apply as usual.

| Rule | Checks |
|---|---|
| `stateless-ready` | the server answers `server/discover` (the connection negotiated the 2026-07-28 era, no `initialize`), lists `supportedVersions`, and serves `tools/list` (SEP-2575) |
| `deterministic-list-order` | two consecutive `tools/list` calls (all pages, client cache bypassed) return the same tools in the same order (2026-07-28 changelog: servers SHOULD) |
| `resource-not-found-code` | reading a made-up URI fails with `-32602`, not the legacy `-32002` (SEP-2164); needs the `resources` capability |
| `reserved-error-range` | the error answers to safe probes (an unknown method, a made-up tool name, `tools/call` without a name, a missing resource) do not use codes from `-32020`..`-32099`, which the 2026-07-28 spec reserves for itself (only `-32020`, `-32021`, `-32022` are assigned, and none describes these conditions; basic/index "Error Codes", changelog change 12). Judged on 2026-07-28 connections only. It never calls a real tool: a server cannot be made to emit its own undefined codes on demand, so only what these probes provoke is checked |
| `sse-only-transport` | a `--url` server is reachable over Streamable HTTP, not only over the deprecated HTTP+SSE transport (`GET` opens an event stream whose first event is `endpoint`, and `POST` is not a JSON-RPC endpoint). HTTP+SSE is Deprecated under SEP-2596. This is the one rule that still runs when the connection fails, so an SSE-only server gets a finding instead of just a connect error |
| `server-card` | an HTTP server (`--url`) publishes a Server Card at `<url>/server-card` (warns on 404 or an unusable card) and the card agrees with the live connection: connected URL, server name/version, negotiated and supported protocol versions (SEP-2127; the live values win). Silent for stdio servers |

```bash
npx tsx packages/mcp-lint/src/cli.ts --url https://host/mcp --probe
```

`x-mcp-file` has no published specification yet (SEP-2356 was closed), so that rule is experimental.
`tool-title-icons` stays on at `warn` by default.

The annotation rules are heuristic (they match verb segments in names), so they're warnings
you can silence per-rule when a name is a false positive.

## Programmatic API

```ts
import { lintContract, formatLint, RULES } from "@mcp-query/lint";
import { captureContract } from "@johnhenry/mcp-contract";

const contract = await captureContract(connectedSdkClient);
const result = lintContract(contract, { rules: { "naming-consistency": "off" } });
if (result.errors) throw new Error(formatLint(result));
```

`lintContract(contract, opts)` returns `{ findings, errors, warnings, skipped? }` (`skipped` lists rules that could not be evaluated on this capture). Findings carry
`{ rule, severity, target, message }`. Pass `opts.rules` to override any rule's severity.

## Family

| Project | Role |
|---|---|
| mcp-query | consume MCP |
| mcp-gate | govern at runtime |
| mcp-contract | guard the interface in CI (drift) |
| **mcp-lint** | **lint surface quality in CI** |
| mcp-record | freeze real traffic as fixtures |

## Tests

```bash
npx vitest run   # each rule + severity overrides + a clean-surface baseline
```

## Status

MVP (`private: true`). Roadmap: live-probe rules (see above), per-rule config file, autofix suggestions, JSON output,
and a GitHub Action.
