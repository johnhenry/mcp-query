# mcp-record

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

## Install / use

Runs from source via `tsx` in this monorepo:

```bash
# 1. Record: capture the capability surface + the real results of specific calls
npx tsx packages/mcp-record/src/cli.ts record \
  --command npx --args "-y @modelcontextprotocol/server-everything" \
  --out everything.tape.json \
  --call 'echo:{"message":"hello"}' \
  --call 'get-sum:{"a":2,"b":3}'

# 2. Replay: serve the cassette as an offline MCP server over stdio
npx tsx packages/mcp-record/src/cli.ts replay --cassette everything.tape.json

# 3. Inspect: summarize a cassette
npx tsx packages/mcp-record/src/cli.ts inspect everything.tape.json
```

`record` always captures the listings (`tools/list`, `resources/list`,
`resources/templates/list`, `prompts/list`) plus the `initialize` capabilities/identity;
each `--call name:json` additionally records that tool's real result.

Drop the replay server into an MCP host (CI, a demo) exactly where the real one would go:

```jsonc
{ "mcpServers": { "everything": {
  "command": "npx",
  "args": ["tsx", "packages/mcp-record/src/cli.ts", "replay", "--cassette", "everything.tape.json"]
}}}
```

## Programmatic API

Record by wrapping any transport; replay as a server or a transport factory:

```ts
import { createCassette, recordTransport, replayServer, replayTransport } from "@mcp-query/record";

// ── record (e.g. once, against a real upstream) ──
const cassette = createCassette();
const client = new Client({ name: "app", version: "1" }, { capabilities: {} });
await client.connect(recordTransport(realTransport, cassette)); // initialize → capabilities
await client.callTool({ name: "echo", arguments: { message: "hi" } });
await writeFile("tape.json", JSON.stringify(cassette, null, 2));

// ── replay (in tests / offline) ──
const tape = JSON.parse(await readFile("tape.json", "utf8"));
const client2 = new Client({ name: "test", version: "1" }, { capabilities: {} });
await client2.connect(replayTransport(tape)());     // a ConnectionConfig-style factory
// …or serve it: await replayServer(tape).connect(new StdioServerTransport());
```

`replayTransport(cassette)` is a `() => Transport` factory — usable directly as an mcp-query
upstream `transport`, so a recorded server slots into the same client wiring as the live one.

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
npx vitest run   # record→replay identity, ordered episodes, capability fidelity
```

All headless against an in-memory `MockMCPServer` — record through it, replay without it,
assert identical results and that the upstream was never touched again.

## Status

MVP (`private: true`). Roadmap: record over Streamable HTTP, capture notifications &
sampling/elicitation exchanges, redaction-on-record (pair with mcp-gate), and a `--update`
mode that re-records only changed interactions.
