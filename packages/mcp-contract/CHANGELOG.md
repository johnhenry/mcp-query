# @johnhenry/mcp-contract

## 0.2.0

### Minor Changes

- 3a0742c: **Default changed: captures now use `--era auto`.** `mcp-contract snapshot` / `verify` / `diff` and the library's `connectClient` / `captureFrom` used to connect with the plain `initialize` handshake. They now probe `server/discover` first (bounded, 5 s, `MCPQ_ERA_PROBE_TIMEOUT_MS` overrides; a stdio server is started one extra time for the probe) and fall back to `initialize`, the same default as `mcp-query`, `mcp-bench` and `mcp-record`. Against a server that speaks 2026-07-28 a capture therefore gains `protocol.supported`, `ttlMs` / `cacheScope` in `cacheHints` and a 2026-07-28 `protocol.negotiated`; a 2025-era server is captured as before. Choose with `--era auto|legacy` on the CLI (`--era legacy` keeps the old capture), the new `era` option of `ConnectOptions` (so `captureFrom({ url, era: "legacy" })`), or a registry entry's pinned `era` (the flag wins over the pin). New exports: `withEra`, `ERA_FLAG_HELP`, `captureEra`.

  Existing pins keep working. The handshake that produced a capture is recorded in `protocol.era` (no format bump; `captureContract` also infers it on SDK shapes without `getProtocolEra`). `diffContract` treats an era difference like the v1 to v2 one: fields the other handshake cannot carry are "not captured", never "changed". A legacy pin (format v1 or v2, with or without `protocol.era`) verified against a new modern capture of the same server reports no breaking change and `verify` exits 0, and so does a modern pin verified with `--era legacy`; a capability or extension the other handshake does not report is downgraded from breaking to compatible (marked "not comparable across capture eras"), skills / events the legacy capture did not ask for are skipped, and `ContractDiff.notes` (printed by `formatDiff`) says the capture era differs. Tools, resources, templates and prompts stay strict, and between two captures of the same era a dropped protocol version, a removed extension or capability and a narrowed schema are still breaking.

- b95fa93: Shared connection and answering helpers for the tool CLIs, plus the server card. New exports: `connectEra` / `parseEra` / `versionNegotiationFor` / `DEFAULT_ERA` / `ERA_PROBE_TIMEOUT_MS` / `Era` (connect with `legacy` or `auto`, where `auto` probes `server/discover` with a bounded timeout, 5 s by default and `MCPQ_ERA_PROBE_TIMEOUT_MS` to override, and falls back to `initialize`; on HTTP a timed-out probe is retried once as legacy); `parseAnswers` / `answerFor` / `runRounds` / `InputRequiredError` / `describeRequests` / `coerceArgs` (the `--answer key=value` machinery for `input_required` rounds, moved out of the private CLI so `mcp-record` can share it); `cardForContract` and the `ContractCard` / `ContractCardRemote` types (a contract could already carry a card, but the helper was not exported). Registry entries gain an optional `era: "legacy" | "auto"` pin, carried on `ConnectOptions.era`. The `mcp-contract` CLI gains `snapshot --card <url|auto>` (also on `verify` / `diff`) to pin the Server Card. README corrections: the contract's protocol field is `supported`.

### Patch Changes

- Updated dependencies [9f272bb]
- Updated dependencies [fb816ff]
  - @johnhenry/mcp-query@0.8.0

## 0.1.0

### Minor Changes

- 51cf8de: Initial release on npm (previously the private workspace package `@mcp-query/contract`): contract testing and drift detection for MCP capability surfaces. Pin a server's tools, resources, prompts, extensions and protocol surface to `mcp.contract.json`, classify every change as breaking or compatible with input/output variance (`diffSchema`, `diffContract`), serve a contract as a mock server, and gate CI with the `mcp-contract` CLI (`snapshot`, `verify`, `diff`, `mock`, `auth`, `--help`). Ships a built `dist/` and a `browser` export condition resolving to a Node-free subset (capture from a connected client, diff, report, mock). The CLI now works when run through an npm `bin` symlink.

### Patch Changes

- 584c7ae: `FileOAuthProvider` now type-checks against `@modelcontextprotocol/client` 2.1.0 and later as well as 2.0.0: its `dpop` member takes the installed SDK's own type where the SDK declares one, instead of a narrower local shape that newer SDKs reject. Runtime behaviour is unchanged.
- Updated dependencies [3363512]
- Updated dependencies [e3f8f5c]
- Updated dependencies [3cc0f6e]
- Updated dependencies [7f4791b]
- Updated dependencies [1a9f81b]
- Updated dependencies [a1dfc17]
- Updated dependencies [fc9a255]
- Updated dependencies [d1839fe]
  - @johnhenry/mcp-query@0.7.0
