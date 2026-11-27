---
"@johnhenry/mcp-record": minor
---

Initial release on npm (previously the private workspace package `@mcp-query/record`): record real MCP traffic to a cassette and replay it offline as a deterministic mock (`recordTransport`, `replayTransport`, `replayServer`, `sealCassette`, `loadCassette`, and the `mcp-record` CLI with `record`, `replay`, `inspect`, `--help`). Ships a built `dist/` and a `browser` export condition: record/replay transports and cassette sealing work in a browser bundle with no `node:` module (cassette hashing now uses a built-in synchronous SHA-256 with hashes identical to the previous `node:crypto` ones). The CLI now works when run through an npm `bin` symlink. Depends on `@johnhenry/mcp-contract`.
