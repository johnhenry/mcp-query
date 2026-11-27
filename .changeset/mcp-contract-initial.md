---
"@johnhenry/mcp-contract": minor
---

Initial release on npm (previously the private workspace package `@mcp-query/contract`): contract testing and drift detection for MCP capability surfaces. Pin a server's tools, resources, prompts, extensions and protocol surface to `mcp.contract.json`, classify every change as breaking or compatible with input/output variance (`diffSchema`, `diffContract`), serve a contract as a mock server, and gate CI with the `mcp-contract` CLI (`snapshot`, `verify`, `diff`, `mock`, `auth`, `--help`). Ships a built `dist/` and a `browser` export condition resolving to a Node-free subset (capture from a connected client, diff, report, mock). The CLI now works when run through an npm `bin` symlink.
