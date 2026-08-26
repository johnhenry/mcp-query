# Cross-package examples

Runnable compositions of the monorepo's packages — each one drives two or
more of them through the same `MCPClient` surface, against an in-process
`MockMCPServer` (no subprocess, no network, no credentials).

```sh
npm run build:examples   # once
npm run example:01       # …through example:06
```

| Example | Shows |
| --- | --- |
| [01-client-and-mock-server.ts](./01-client-and-mock-server.ts) | The pair every other example builds on: a `MockMCPServer` queried by an `MCPClient`. |
| [02-gate-the-client.ts](./02-gate-the-client.ts) | mcp-gate in library mode fronting the same mock — deny globs, DLP redaction, audit — and `gate.client` *is* an `MCPClient`, so 01's code runs unchanged, governed. |
| [03-record-and-replay.ts](./03-record-and-replay.ts) | mcp-record taping a live session, then replaying the cassette as a deterministic offline server. |
| [04-contract-drift.ts](./04-contract-drift.ts) | mcp-contract snapshotting a capability surface, then classifying a simulated redeploy's changes as breaking vs compatible. |
| [05-gated-replay-pipeline.ts](./05-gated-replay-pipeline.ts) | Three packages composed: cassette replay standing in for production, governed by the gate, called through `gate.client` — real recorded data, offline, redacted. |
| [06-tanstack-headless.ts](./06-tanstack-headless.ts) | mcp-query-tanstack's `queryOptions` factories driven in plain Node — TanStack Query's cache fed by mcp-query's, no React required. |

Per-package example sets live next to their packages —
[mcp-query](../packages/mcp-query/examples/),
[mcp-gate](../packages/mcp-gate/examples/),
[mcp-record](../packages/mcp-record/examples/),
[mcp-contract](../packages/mcp-contract/examples/) — and the annotated tour
of all of them is at
[opensource.johnhenry.me/agent-query/examples](https://opensource.johnhenry.me/agent-query/examples/).
