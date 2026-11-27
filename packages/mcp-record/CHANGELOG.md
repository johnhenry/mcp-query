# @johnhenry/mcp-record

## 0.2.0

### Minor Changes

- b95fa93: `mcp-record replay` (stdio) now serves a 2026-07-28 cassette to a modern client with `server/discover` and no `initialize` (it previously served only the classic handshake); a 2025-era cassette is served as before. `mcp-record record --call` can answer `input_required` rounds with a repeatable `--answer key=value` (every round is recorded as its own interaction) and fails clearly without one instead of writing a half cassette. `record --era` now defaults to `auto` (a bounded `server/discover` probe, then `initialize`; a failed `auto` connect is retried once as `legacy`), so a server that speaks 2026-07-28 is recorded as a modern cassette, and a registry entry's `era` pin applies. Use `--era legacy` for the old behaviour. README: documents `--redact`, `--era`, `--answer` and the `tool(a: 1)` call form.

### Patch Changes

- bb473c5: Fix `replayTransport` on a 2026-07-28 (modern-era) cassette: the replay cursor was rebuilt for every HTTP request, so repeated identical calls (for example `tasks/get` polling) always returned the first recorded result instead of the recorded sequence. The cursor now lives for the whole connection. Surfaced by running the suite on an SDK that lets `tasks/*` through.
- Updated dependencies [9f272bb]
- Updated dependencies [3a0742c]
- Updated dependencies [b95fa93]
- Updated dependencies [fb816ff]
  - @johnhenry/mcp-query@0.8.0
  - @johnhenry/mcp-contract@0.2.0

## 0.1.0

### Minor Changes

- 51cf8de: Initial release on npm (previously the private workspace package `@mcp-query/record`): record real MCP traffic to a cassette and replay it offline as a deterministic mock (`recordTransport`, `replayTransport`, `replayServer`, `sealCassette`, `loadCassette`, and the `mcp-record` CLI with `record`, `replay`, `inspect`, `--help`). Ships a built `dist/` and a `browser` export condition: record/replay transports and cassette sealing work in a browser bundle with no `node:` module (cassette hashing now uses a built-in synchronous SHA-256 with hashes identical to the previous `node:crypto` ones). The CLI now works when run through an npm `bin` symlink. Depends on `@johnhenry/mcp-contract`.

### Patch Changes

- Updated dependencies [3363512]
- Updated dependencies [e3f8f5c]
- Updated dependencies [584c7ae]
- Updated dependencies [3cc0f6e]
- Updated dependencies [7f4791b]
- Updated dependencies [1a9f81b]
- Updated dependencies [a1dfc17]
- Updated dependencies [fc9a255]
- Updated dependencies [51cf8de]
- Updated dependencies [d1839fe]
  - @johnhenry/mcp-query@0.7.0
  - @johnhenry/mcp-contract@0.1.0
