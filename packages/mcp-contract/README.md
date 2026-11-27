# @johnhenry/mcp-contract

**Contract testing & breaking-change detection for MCP servers.** Pin an MCP server's
capability surface — its tools (with input/output JSON Schemas + annotations), resources,
templates, and prompts — to a versioned `mcp.contract.json`, then fail CI the moment a
live server **drifts incompatibly**.

It's the **dual of [mcp-query](https://github.com/johnhenry/mcp-query#readme) codegen**: codegen turns a server into
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

## Install

```bash
npm install --save-dev @johnhenry/mcp-contract
# or run it without installing:
npx @johnhenry/mcp-contract --help
```

Requires Node >= 26. The CLI is `mcp-contract`; the same code is importable as a library (see
[Programmatic API](#programmatic-api)). `@johnhenry/mcp-query` and the official MCP SDK
(`@modelcontextprotocol/client`, `@modelcontextprotocol/server`) are regular dependencies and
install with it.

## CLI

```bash
# 1. Pin the surface (commit mcp.contract.json to your repo)
npx mcp-contract snapshot \
  --command npx --args "-y @modelcontextprotocol/server-everything" \
  --out mcp.contract.json

# 2. In CI: fail the build if the live server drifted in a breaking way
npx mcp-contract verify \
  --contract mcp.contract.json \
  --command npx --args "-y @modelcontextprotocol/server-everything"
#   -> exits 1 on any BREAKING change, 0 otherwise

# 3. Human-readable diff between two pinned snapshots
npx mcp-contract diff old.contract.json new.contract.json

# 4. Serve the contracted surface as a mock MCP server over stdio (for consumer tests)
npx mcp-contract mock --contract mcp.contract.json

# 5. OAuth-protected hosted server: authorize once (see below)
npx mcp-contract auth --url https://host/mcp
```

`mcp-contract --help` prints the full usage.

### Pinning the Server Card

A remote server may publish a Server Card (SEP-2127) that says where and how to connect. `--card` fetches it
during `snapshot` and pins its identity and remotes (name, and each remote's type, URL and
`supportedProtocolVersions`; never tools or capabilities) in the contract's `card` field. A later
`verify` / `diff` that is also given `--card` reports a changed endpoint or a dropped protocol version as drift.

```bash
npx mcp-contract snapshot --url https://host/mcp --card auto --out mcp.contract.json   # <url>/server-card
npx mcp-contract snapshot --command … --card https://host/.well-known/…/card            # a stdio server: name the card
```

From code: `cardForContract(card, url)` reduces a parsed card (for example from `fetchServerCard` in
`@johnhenry/mcp-query/discovery`) to a `ContractCard`, and `captureContract(client, { card })` records it.
Both, and the `ContractCard` type, are exported. Plain-http cards are accepted on loopback only.

## Connecting: local or hosted

A live server is reached either over **stdio** (a locally-spawned process) or **Streamable
HTTP** (a hosted endpoint). Everywhere a command above takes `--command`, it also accepts:

```bash
--url https://host/mcp                 # Streamable HTTP endpoint
--bearer "$TOKEN"                       # → Authorization: Bearer $TOKEN
--header "X-Tenant: acme"               # arbitrary header(s), repeatable
```

### OAuth-protected servers

Hosted MCP servers are commonly **OAuth-protected** — an unauthenticated capture returns
`401`. Two ways to authenticate:

```bash
# A) you already have a token
mcp-contract snapshot --url https://host/mcp --bearer "$TOKEN" --out api.contract.json

# B) browser-consent flow (dynamic client registration + PKCE) — run once
mcp-contract auth --url https://host/mcp [--scope "a b c"]
#   → registers a client, opens the authorize URL (or prints it), you log in + approve;
#     the token is cached at ~/.mcp-query/oauth/<host>.json
mcp-contract verify --url https://host/mcp --contract api.contract.json   # just works now
```

`auth` runs the full OAuth 2.1 flow itself — it never sees your password (you log in on the
server's own page). The token is cached per-host and **auto-refreshed** by the capture commands on later runs; if
nothing is cached they tell you to run `auth` first.

**Client registration: CIMD first, DCR as fallback.** If the authorization server advertises
`client_id_metadata_document_supported`, the CLI uses a [Client ID Metadata
Document](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
as its `client_id` and registers nothing. Otherwise it falls back to Dynamic Client Registration
(deprecated by the 2026-07-28 revision, kept for older servers). The document is checked in at
[`oauth/client-metadata.json`](../../oauth/client-metadata.json) and its `client_id` is its own URL,
`https://johnhenry.github.io/mcp-query/oauth/client-metadata.json` (GitHub Pages; `raw.githubusercontent.com`
is not used because it serves `text/plain`, and the draft requires a JSON response). Its `redirect_uris`
are the fixed loopback callbacks on port 8976, so CIMD login binds that port (and falls back to DCR with
an ephemeral port if it is busy). Override the URL with `MCPQ_CLIENT_METADATA_URL` or
`--client-metadata-url <https-url>`; `off` disables CIMD.

| Flag | Effect |
| --- | --- |
| `--client-metadata-url <url\|off>` | use another CIMD, or disable CIMD (DCR only) |
| `--expected-issuer <iss>` | pin the authorization server; any other discovered issuer is refused before registration |
| `--dpop` | opt-in DPoP (RFC 9449): sender-constrained tokens; key stored `0600`, never logged. Needs SDK >= 2.1.0 |

The `iss` authorization-response parameter is validated (RFC 9207) before the code is redeemed.
Credentials are stored per authorization-server issuer (SEP-2352); a cache file written before that
change is never reused for an explicit issuer, and the cache is written owner-only (`0600`).

**Browser on a different machine (e.g. the tool runs on a remote box you SSH into).** The
callback is `http://localhost:PORT/callback` on the *box*, but your logged-in browser is on
your laptop. Two ways to bridge it:

```bash
# A) SSH local-forward the callback port, then the redirect "just works":
ssh -L 41234:localhost:41234 you@box           # forward laptop:41234 → box:41234
# on the box:
mcp-contract auth --url https://host/mcp --port 41234 --open false
# open the printed URL in your laptop browser, approve → redirect tunnels back to the box.

# B) No tunnel: approve in your browser, copy the failed localhost/callback?code=… URL
#    from the address bar, and paste it at the "paste the redirected URL" prompt.
```

`--port` fixes the callback port so you can set up `-L` in advance; `--open false` skips
launching a browser on the (headless) box.

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
| Extension **removed**, or its `revision` changed | **breaking** |
| Protocol version **dropped** from `protocol.supported` (the `server/discover` `supportedVersions`) | **breaking** |
| Server capability removed, or `listChanged` / `subscribe` no longer advertised | **breaking** |
| Event type removed, `payloadSchema` narrowed (output variance), or a delivery mode removed | **breaking** |
| Skill removed | **breaking** |
| New tool / resource / prompt | compatible |
| Extension / capability / protocol version added; tool `title` / `icons` / `_meta` changed | compatible |
| A skill's file digest changed, or a file was added/removed (content under a stable URI) | **content drift** (own class; reported, never fails `verify`) |
| New **optional** input arg; output gains a field | compatible |
| Input widened (enum grows, `integer`→`number`); description changes | compatible |

## Contract format v2

`snapshot` now writes `"version": 2`. On top of v1's tools / resources / templates / prompts it captures:

- `capabilities` and `extensions` (`capabilities.extensions`, each with its `revision` when the server sends one);
- `protocol`: `era` (`modern` / `legacy`), `negotiated` and, on a 2026-07-28 connection, `supported` (the
  `supportedVersions` that `server/discover` returned, sorted);
- per tool: `title`, `icons`, `_meta`;
- `cacheHints`: the `ttlMs` / `cacheScope` seen on `server/discover` and each list call (SEP-2549);
- `skills` and `events` when the server advertises `io.modelcontextprotocol/skills` / `io.modelcontextprotocol/events`.
  These are extension methods outside the SDK's typed API, so they are fetched with a raw `skills/list` /
  `events/list` request, only when the extension is advertised, and any failure just leaves the field out. Nothing
  here needs an SDK newer than 2.0.0, and the SDK getters used for `protocol` are read defensively.

v1 contracts keep working: every reader (`verify`, `diff`, `mock`, lint, docs) goes through `upgradeContract`, which
bumps `version` and leaves the v2-only fields absent. **Absent means "not captured"**, so diffing a v1 pin against a
live v2 capture reports none of them as changes; re-run `snapshot` to start pinning them. A file with any other
`version` is rejected with a clear error.

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
import { captureContract, diffContract, mockFromContract, diffSchema, formatDiff } from "@johnhenry/mcp-contract";

const pinned = JSON.parse(await readFile("mcp.contract.json", "utf8"));
const live = await captureContract(connectedSdkClient);     // drain a live server
const diff = diffContract(pinned, live, { used: ["echo"] }); // classify drift
if (diff.breaking) throw new Error(formatDiff(diff));

// low-level: classify a single schema change under a variance
diffSchema(prevInputSchema, nextInputSchema, "in");   // → SchemaChange[]

// turn a contract into a runnable test double (mcp-query MockMCPServer)
const mock = mockFromContract(pinned);
```

## Browser entry

`@johnhenry/mcp-contract` has a `browser` export condition (Vite, webpack and
`esbuild --platform=browser` pick it up by default) that resolves to a Node-free subset: contract
capture from an already-connected `Client`, `diffContract`, `upgradeContract`, `diffSchema`,
`formatDiff`, `mockFromContract`, `usedFromSource` and the call-spec parser. That is enough to render
or diff pinned contracts in a web UI. The stdio/HTTP connectors, the server registry and the OAuth
flow need Node and are not part of the browser entry; a test bundles the entry for a browser
platform and fails if any `node:` module sneaks in.

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
| **mcp-record** | freeze real traffic as fixtures (offline replay) |

## MCP SDK versions

| Feature | Minimum `@modelcontextprotocol/client` |
| --- | --- |
| Client ID Metadata Documents (preferred) with DCR fallback, `iss` validation (RFC 9207), issuer-keyed credentials, `discoveryState` binding | 2.0.0 |
| `--dpop` (DPoP, RFC 9449: `OAuthClientProvider.dpop()`, `DpopSession`) | 2.1.0 |

The peer range stays `^2.0.0`. `--dpop` on an older SDK stops with an error naming the 2.1.0 requirement
instead of silently sending bearer tokens. `--expected-issuer` is enforced by `FileOAuthProvider` itself
(it checks the discovered issuer before registering or redirecting), so it works on every 2.x. The SDK's own
`expectedIssuer` option belongs to its static-credential providers (`ClientCredentialsProvider` and friends; present
in the 2.0.0 typings, and required by their newer overloads), not to this interactive flow, whose `iss` check
(RFC 9207) the SDK performs from 2.0.0.

## Tests

```bash
npm test -w @johnhenry/mcp-contract   # from a clone of the repo: variance engine (in/out), capture, diff classification, scoping, mock, used-scan
```

All tests run headless against an in-memory `MockMCPServer` — no network, no subprocess.

## Status

Pre-1.0: the contract file format is versioned (see above) and read compatibly across versions, but
the library API may still change in minor releases. Roadmap: richer JSON Schema coverage
(`anyOf`/`oneOf`/`$ref`, `additionalProperties`), `--format json` for machine consumption, and a
GitHub Action wrapper.

## Releasing

Published from `main` by `.github/workflows/release-mcp-contract.yml` (do not rename; npm trusted
publishing is keyed to the filename). A brand-new package cannot be created by trusted publishing, so the
**first** release is manual, from a logged-in maintainer shell, once the Changesets "Version Packages"
PR has bumped the package to `0.1.0`:

```bash
npm run build -w @johnhenry/mcp-query -w @johnhenry/mcp-contract
cd packages/mcp-contract && npm publish --access public
npm trust github @johnhenry/mcp-contract --repository johnhenry/mcp-query --file release-mcp-contract.yml --allow-publish
```

After that, the Version Packages PR drives every release like the other packages.
