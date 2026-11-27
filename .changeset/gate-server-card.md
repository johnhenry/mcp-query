---
"@johnhenry/mcp-gate": minor
---

The gate can publish a Server Card (SEP-2127) for its own endpoint: `GateConfig.card` (`url`, `name`, `version`, optional `description`/`title`/`websiteUrl`/`supportedProtocolVersions`/`listUpstreams`), `gateServerCard(config)` for the card object, and `createGateCardHandler(config)`, a web-standard `(req: Request) => Response | undefined` that serves it at `<endpoint>/server-card` (the SEP's reserved location, with the card media type, CORS and cache headers) and falls through for every other path so it composes in front of your MCP handler. The card describes only the gate (identity, its transport endpoint, supported protocol versions) and says nothing about upstreams unless `card.listUpstreams: true`, which publishes upstream names only (never URLs, commands or headers). The gate has no HTTP server of its own, so mounting is documented in the README.
