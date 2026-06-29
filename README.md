# mcp-query ecosystem

A data-layer ecosystem for the **Model Context Protocol** — a reactive client and the
governance, testing, and fixture tooling built around it. Same shape as the GraphQL world
(Apollo Client + a gateway + schema checks + mocking), but for MCP.

This repo is an npm-workspaces monorepo. The packages share one core (`mcp-query`) and
compose along a clean seam (an interceptor chain + a transport tap), so each does one job
and they stack:

```
                            ┌─────────────────────────────────────────────┐
   your app / agent host ──▶│                 mcp-query                    │──▶ MCP servers
                            │   reactive client · cache · codegen · core   │
                            └─────────────────────────────────────────────┘
                                  ▲             ▲              ▲
                  ┌───────────────┘   ┌─────────┘   ┌──────────┘
            ┌───────────┐       ┌───────────┐  ┌───────────┐
            │ mcp-gate  │       │mcp-contract│  │ mcp-record│
            │ govern at │       │ guard the  │  │ freeze    │
            │ runtime   │       │ interface  │  │ traffic   │
            └───────────┘       └───────────┘  └───────────┘
```

## Packages

| Package | What it does | When you reach for it |
|---|---|---|
| **[mcp-query](packages/mcp-query)** | The reactive, cached, embeddable MCP **client**: TanStack-Query-style document cache, RTK-Query tags, LSP-client lifecycle, React hooks, codegen, an interceptor chain, and optional server-side modules (gateway, metrics, OTel, sessions, Redis L2). | You're **consuming** MCP servers from an app or backend and want a real data layer, not raw SDK calls. |
| **[@mcp-query/gate](packages/mcp-gate)** | A config-driven **security/policy proxy**. Fronts many upstreams as one governed endpoint: declarative authorization, DLP redaction, rate-limit, circuit-breaking, audit. | You're handing MCP servers to an agent and need a **runtime choke point** — allow/deny, scrub secrets, log everything. |
| **[@mcp-query/contract](packages/mcp-contract)** | **Contract testing / drift detection.** Pin a server's capability surface, then fail CI when a live server changes incompatibly (with proper input/output variance). The dual of codegen. | You generated/wrote code against an MCP server and want CI to **catch breaking drift** before it ships. |
| **[@mcp-query/record](packages/mcp-record)** | **Record / replay** (VCR for MCP). Capture real server traffic to a cassette, replay it offline as a deterministic mock. | Your tests/demos need a server's **real output** but fast, offline, and frozen. |

Plus **[apps/inspector](apps/inspector)** — a flagship MCP Inspector (Web Components + Vite +
a stdio/HTTP proxy) that dogfoods the framework-agnostic core.

## How they relate

- **One core, composable seams.** `mcp-gate` is just `mcp-query`'s `MCPClient` behind its
  `createGateway`, with an interceptor stack. `mcp-record` taps the same `instrumentTransport`
  seam the devtools use. `mcp-contract`'s mock and `mcp-record`'s replay both build on the
  shared `MockMCPServer`.
- **contract vs record:** a *contract* pins the **shape** (schemas/annotations) to catch drift;
  a *cassette* freezes the **real results** for offline replay. Use both — contract in CI,
  cassettes in tests.

## Develop

```bash
npm install                 # install all workspaces

npm test                    # run every workspace's test suite
npm run build               # build the publishable mcp-query package (dist/)
npm run typecheck           # typecheck all workspaces

# work in one package
npm test -w mcp-query
npm test -w @mcp-query/gate
npm run dev -w @mcp-query/inspector
```

In this monorepo the gate/contract/record packages consume `mcp-query` directly from its
TypeScript **source** (`packages/mcp-query/src`) for a zero-build dev loop; only `mcp-query`
itself emits a `dist/` for publishing.

## Status

`mcp-query` is the publishable core (`0.0.1`); the gate/contract/record packages and the
inspector are MVPs (`private`) tracking it. See each package's README for specifics.

## License

[MIT](LICENSE)
