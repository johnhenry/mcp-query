# @johnhenry/mcp-contract

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
