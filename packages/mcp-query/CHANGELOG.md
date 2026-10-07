# @johnhenry/mcp-query

## 0.2.2

### Patch Changes

- 48b6dad: Widen the `@modelcontextprotocol/client` and `@modelcontextprotocol/server` ranges from the exact `2.0.0` to `^2.0.0`, so consumers on any 2.x SDK install without `ERESOLVE` peer warnings. In `@johnhenry/mcp-query` these are peer dependencies; in `@johnhenry/mcp-gate` they are regular dependencies, so the wider range lets npm dedupe to the single SDK copy the consumer already has instead of installing a second 2.0.0. The suite passes against SDK 2.0.0 (the floor) and the latest 2.x (2.3.1), and CI now runs the SDK-using packages against both (#42).
