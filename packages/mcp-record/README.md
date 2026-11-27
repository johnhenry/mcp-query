# @johnhenry/mcp-record

**Record real MCP server traffic to a cassette, replay it offline as a deterministic
mock.** VCR / Polly / nock, for the Model Context Protocol.

Point it at a live MCP server, exercise it, and `mcp-record` captures every
request→response into a `*.tape.json`. Later, replay that cassette as a real (offline,
deterministic) MCP server — your tests, demos, and CI run against the *actual data the
server returned*, with no subprocess, no network, no flakiness, no API keys.

```
   record                                     replay
  ┌──────────┐   recordTransport   ┌────────┐        ┌──────────────┐   real recorded
  │  client  │ ─────────tap──────▶ │ live   │        │  tape.json   │ ───results──▶  your tests
  └──────────┘   (mcp-query seam)  │ server │        └──────────────┘   (offline, deterministic)
        └──────── tape.json ◀──────┘                  replayServer / replayTransport
```

## Why — and how it differs from mcp-contract

| | captures | replay returns |
|---|---|---|
| **mcp-contract** `mockFromContract` | the *shape* (schemas, annotations) | placeholder content |
| **mcp-record** `replayServer` | the *real* request→response pairs | the actual recorded results |

Use a **contract** to assert a server's surface hasn't drifted; use a **cassette** when your
test needs the server's *real output* but you want it fast, offline, and frozen.

## Install

```bash
npm install --save-dev @johnhenry/mcp-record
# or run it without installing:
npx @johnhenry/mcp-record --help
```

Requires Node >= 26. The CLI is `mcp-record`; the same code is importable as a library (see
[Programmatic API](#programmatic-api)). `@johnhenry/mcp-query`, `@johnhenry/mcp-contract` (the
CLI's connector) and the official MCP SDK are regular dependencies and install with it.

## CLI

```bash
# 1. Record: capture the capability surface + the real results of specific calls
npx mcp-record record \
  --command npx --args "-y @modelcontextprotocol/server-everything" \
  --out everything.tape.json \
  --call 'echo:{"message":"hello"}' \
  --call 'get-sum:{"a":2,"b":3}'

# 2. Replay: serve the cassette as an offline MCP server over stdio
npx mcp-record replay --cassette everything.tape.json

# 3. Inspect: summarize a cassette and verify its integrity hash
npx mcp-record inspect everything.tape.json
```

`record` always captures the listings (`tools/list`, `resources/list`,
`resources/templates/list`, `prompts/list`) plus the `initialize` capabilities/identity;
each `--call name:json` additionally records that tool's real result. A hosted server works
the same way with `--url https://host/mcp [--bearer ...] [--header "K: V"]`.

Drop the replay server into an MCP host (CI, a demo) exactly where the real one would go:

```jsonc
{ "mcpServers": { "everything": {
  "command": "npx",
  "args": ["mcp-record", "replay", "--cassette", "everything.tape.json"]
}}}
```

## Cassette format versions and the 2026-07-28 surface

Cassettes carry a `version`. This build writes **2** and reads **1** (and cassettes with no `version`):
a v1 file is upgraded in memory on load, its integrity seal is verified against the original hash first
and then re-issued in the new format. A version newer than the build understands is refused with a clear error.

What v2 adds:

- `protocol` (`era`, negotiated `version`, `supportedVersions`). On a 2026-07-28 connection there is
  no `initialize`; the header is filled from `server/discover` (record with `--era auto`, or any client
  using `versionNegotiation: auto`). `replayTransport` serves a modern cassette through the SDK's
  era-aware handler, so a modern client negotiates with `server/discover` against the replay too.
  The integrity hash covers this header as well as the interactions.
- `kind` / `mrtr` tags on interactions, derived from the wire: **multi round-trip requests**
  (`input_required` result = `round` 0, each retry carrying `requestState` / `inputResponses` = the next
  round), **task** exchanges (`tasks/*`, task handles) and **skill** calls (`skills/*`).
- Replay matches a retry on its `inputResponses` and `requestState`, restored from the request context
  because the SDK lifts them out of `params`, so round 0 and round N never get mixed up. Matching is
  exact by default; `replayTransport(cassette, { looseInputResponses: true })` opts in to replaying
  a recorded retry against *different* answers (same method, params and `requestState`).
- `tasks/get` polling replays the recorded statuses in order and the terminal status sticks;
  `tasks/update` / `tasks/cancel` / `skills/list` / `skills/get` replay like any other method.

Limits: `mcp-record replay` (stdio) serves the classic handshake only, so a modern client should use
`replayTransport`. On SDK 2.0.0 `tasks/*` are era-gated off the 2026-07-28 wire (both ends), so task
sequences on a modern connection need SDK >= 2.3.0; legacy-era task sequences work everywhere.
`record --call` drives tool calls only (no MRTR answers); record richer flows through `recordTransport`
around your own client.

## Programmatic API

Record by wrapping any transport; replay as a server or a transport factory:

```ts
import { Client } from "@modelcontextprotocol/client";
import { createCassette, sealCassette, loadCassette, recordTransport, replayServer, replayTransport } from "@johnhenry/mcp-record";

// ── record (e.g. once, against a real upstream) ──
const cassette = createCassette();
const client = new Client({ name: "app", version: "1" }, { capabilities: {} });
await client.connect(recordTransport(realTransport, cassette)); // initialize → capabilities
await client.callTool({ name: "echo", arguments: { message: "hi" } });
sealCassette(cassette);                                          // stamp the integrity hash
await writeFile("tape.json", JSON.stringify(cassette, null, 2));

// ── replay (in tests / offline) ──
const tape = loadCassette(await readFile("tape.json", "utf8")); // verifies the integrity hash
const client2 = new Client({ name: "test", version: "1" }, { capabilities: {} });
await client2.connect(replayTransport(tape)());     // a ConnectionConfig-style factory
// …or serve it: await replayServer(tape).connect(new StdioServerTransport());
```

`replayTransport(cassette)` is a `() => Transport` factory — usable directly as an mcp-query
upstream `transport`, so a recorded server slots into the same client wiring as the live one.

## Browser entry

`@johnhenry/mcp-record` has a `browser` export condition (Vite, webpack and
`esbuild --platform=browser` pick it up by default) that resolves to `index.browser.js`: the same
library API (`createCassette`, `recordTransport`, `replayTransport`, `replayServer`,
`sealCassette`, `loadCassette`, ...) with **no `node:` module in the bundle**. Cassette hashing uses
a built-in synchronous SHA-256 rather than `node:crypto`, and gives byte-identical hashes, so a cassette sealed
in Node loads in the browser and vice versa. The file-based pieces (reading and writing tapes) are
yours to do with `fetch`/`File`: `loadCassette` takes a JSON string. The CLI is Node-only and is not
part of the browser entry; a test bundles the entry for a browser platform and fails if any
`node:` module sneaks in.

```ts
import { loadCassette, replayTransport } from "@johnhenry/mcp-record";
import { Client } from "@modelcontextprotocol/client";

const tape = loadCassette(await (await fetch("/fixtures/everything.tape.json")).text());
const client = new Client({ name: "demo", version: "1" }, { capabilities: {} });
await client.connect(replayTransport(tape)());
```

## Behavior notes

- **Faithful:** replay returns the exact recorded `result` for each matched request, and the
  replay server advertises the *recorded* `serverInfo` + capabilities (so identity-sensitive
  code sees the real thing).
- **Deterministic episodes:** repeated identical calls replay their recorded results **in
  order** (stateful sequences), with the last episode sticking. Matching is by method +
  canonical params; volatile `_meta` (progress tokens, etc.) is ignored.
- **Errors recorded too:** a call that returned a protocol error is captured and re-raised on
  replay.
- **Scope:** records the request/response surface (listings, `tools/call`, `resources/read`,
  `prompts/get`, completions). Server-initiated notifications and sampling/elicitation
  round-trips are out of scope for this MVP.

## How it reuses mcp-query

Recording taps the transport through mcp-query's `instrumentTransport` Proxy seam (the same
one devtools uses) — no SDK patching. Replay is a plain SDK `Server` reading the cassette.

## Family

| Project | Role |
|---|---|
| **mcp-query** | consume MCP (reactive client + codegen) |
| **mcp-gate** | govern MCP at runtime (policy, DLP, audit) |
| **mcp-contract** | guard the interface in CI (shape drift) |
| **mcp-record** | freeze real traffic as fixtures (offline replay) |

## Tests

```bash
npm test -w @johnhenry/mcp-record   # from a clone of the repo: record→replay identity, ordered episodes, capability fidelity
```

All headless against an in-memory `MockMCPServer` — record through it, replay without it,
assert identical results and that the upstream was never touched again.

## Status

Pre-1.0: the cassette format is versioned (see above) and older versions are read compatibly, but the
library API may still change in minor releases. Roadmap: capture notifications &
sampling/elicitation exchanges, and a `--update` mode that re-records only changed interactions.

## Releasing

Published from `main` by `.github/workflows/release-mcp-record.yml` (do not rename; npm trusted
publishing is keyed to the filename). A brand-new package cannot be created by trusted publishing, so the
**first** release is manual, from a logged-in maintainer shell, once the Changesets "Version Packages"
PR has bumped the package to `0.1.0` and `@johnhenry/mcp-contract` is on npm:

```bash
npm run build -w @johnhenry/mcp-query -w @johnhenry/mcp-contract -w @johnhenry/mcp-record
cd packages/mcp-record && npm publish --access public
npm trust github @johnhenry/mcp-record --repository johnhenry/mcp-query --file release-mcp-record.yml --allow-publish
```

After that, the Version Packages PR drives every release like the other packages.
