# @johnhenry/mcp-record

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
