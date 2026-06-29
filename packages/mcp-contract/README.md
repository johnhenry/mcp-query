# mcp-contract

**Contract testing & breaking-change detection for MCP servers.** Pin an MCP server's
capability surface — its tools (with input/output JSON Schemas + annotations), resources,
templates, and prompts — to a versioned `mcp.contract.json`, then fail CI the moment a
live server **drifts incompatibly**.

It's the **dual of [mcp-query](../../README.md) codegen**: codegen turns a server into
types at dev time; `mcp-contract` verifies the server still *honors* those types at every
build. Same role `buf breaking` plays for protobuf, GraphQL schema checks for GraphQL, and
Pact for REST.

```
   dev time                         CI / runtime
  ┌──────────┐  codegen   types    ┌──────────────┐  verify   ┌──────────────┐
  │  server  │ ─────────▶ .ts  ──▶ │ your consumer │ ────────▶ │ mcp-contract │ ✗ breaking → exit 1
  └──────────┘                     └──────────────┘           └──────────────┘
       └──────────── snapshot ──▶ mcp.contract.json ──────────────┘  (the pinned surface)
```

## The gap it fills

mcp-query's codegen snapshots a server's tools *once*. But MCP servers are dynamic —
`list_changed`, tools appearing/vanishing, an argument quietly becoming required, a
read-only tool turning destructive. Nothing otherwise catches the moment the server you
generated (and wrote policy) against no longer matches. `mcp-contract` is that safety net.

## Install / use

Runs from source via `tsx` in this monorepo:

```bash
# 1. Pin the surface (commit mcp.contract.json to your repo)
npx tsx packages/mcp-contract/src/cli.ts snapshot \
  --command npx --args "-y @modelcontextprotocol/server-everything" \
  --out mcp.contract.json

# 2. In CI: fail the build if the live server drifted in a breaking way
npx tsx packages/mcp-contract/src/cli.ts verify \
  --contract mcp.contract.json \
  --command npx --args "-y @modelcontextprotocol/server-everything"
#   → exits 1 on any BREAKING change, 0 otherwise

# 3. Human-readable diff between two pinned snapshots
npx tsx packages/mcp-contract/src/cli.ts diff old.contract.json new.contract.json

# 4. Serve the contracted surface as a mock MCP server over stdio (for consumer tests)
npx tsx packages/mcp-contract/src/cli.ts mock --contract mcp.contract.json
```

## Connecting: local or hosted

A live server is reached either over **stdio** (a locally-spawned process) or **Streamable
HTTP** (a hosted endpoint). Everywhere a command above takes `--command`, it also accepts:

```bash
--url https://host/mcp                 # Streamable HTTP endpoint
--bearer "$TOKEN"                       # → Authorization: Bearer $TOKEN
--header "X-Tenant: acme"               # arbitrary header(s), repeatable
```

Hosted MCP servers are commonly **OAuth-protected** — an unauthenticated capture returns
`401`. Supply a token via `--bearer` (or the full header via `--header`); interactive OAuth
(dynamic client registration + browser consent) isn't handled by the CLI. The same
`--url`/`--bearer`/`--header` flags work for `mcp-lint` and `mcp-docs`.

## What counts as breaking — the variance rules

Whether a schema change breaks depends on **direction**, and this is the engine's whole
point (`src/schema.ts`):

- **Tool input is contravariant.** The provider may safely accept *more* (widen). Accepting
  *less* or demanding *more* breaks callers.
- **Tool output is covariant.** The provider must keep producing *at least* what it did, so
  consumers' reads stay valid.

| Change | Verdict |
|---|---|
| Tool / resource / prompt **removed** | **breaking** |
| New **required** input arg, or optional → required | **breaking** |
| Input type narrowed (`number`→`integer`, enum shrinks, base→enum) | **breaking** |
| **Output** field removed, or a produced type widened (`integer`→`number`) | **breaking** |
| Tool gains `destructiveHint`, or loses `readOnlyHint` | **breaking** (policy-relevant) |
| New tool / resource / prompt | compatible |
| New **optional** input arg; output gains a field | compatible |
| Input widened (enum grows, `integer`→`number`); description changes | compatible |

## Consumer-driven contracts

You rarely use a server's *whole* surface. Scope `verify` to only what you actually call,
and the provider can churn everything else freely:

```bash
# explicit list
mcp-contract verify --contract mcp.contract.json --command … --used "echo,get-sum"

# …or infer it by scanning your generated client / source for referenced ids
mcp-contract verify --contract mcp.contract.json --command … --used-by src/mcp.gen.ts
```

`--used-by` reads a source file and keeps only changes touching ids that appear as string
literals in it (via `usedFromSource`) — so drift on tools you never call won't fail your build.

## Programmatic API

```ts
import { captureContract, diffContract, mockFromContract, diffSchema, formatDiff } from "@mcp-query/contract";

const pinned = JSON.parse(await readFile("mcp.contract.json", "utf8"));
const live = await captureContract(connectedSdkClient);     // drain a live server
const diff = diffContract(pinned, live, { used: ["echo"] }); // classify drift
if (diff.breaking) throw new Error(formatDiff(diff));

// low-level: classify a single schema change under a variance
diffSchema(prevInputSchema, nextInputSchema, "in");   // → SchemaChange[]

// turn a contract into a runnable test double (mcp-query MockMCPServer)
const mock = mockFromContract(pinned);
```

## How it reuses mcp-query

- **Capture** drains the same surface mcp-query's codegen introspects.
- **`mock`** builds an mcp-query `MockMCPServer` from the contract and re-serves it via
  `createGateway` (namespace off) — the contract becomes a zero-upstream test double.
- The only net-new code is the **JSON Schema variance engine** (`schema.ts`) and the CLI.

## Family

| Project | Role |
|---|---|
| **mcp-query** | consume MCP (reactive client + codegen) |
| **mcp-gate** | govern MCP at runtime (policy, DLP, audit) |
| **mcp-contract** | guard the MCP interface in CI (drift detection) |

## Tests

```bash
npx vitest run   # variance engine (in/out), capture, diff classification, scoping, mock, used-scan
```

All tests run headless against an in-memory `MockMCPServer` — no network, no subprocess.

## Status

MVP (`private: true`). Roadmap: richer JSON Schema coverage (`anyOf`/`oneOf`/`$ref`,
`additionalProperties`), `--format json` for machine consumption, a GitHub Action wrapper,
and snapshotting over Streamable HTTP transports (today the CLI captures over stdio).
