---
"@johnhenry/mcp-query": minor
---

Opt-in connection preflight from a Server Card: `ConnectionConfig.cardPreflight: { cardUrl, serverUrl?, fetch?, allowInsecureLocalhost?, timeoutMs? }` fetches the server's card (hardened discovery fetch, 3s default budget) before a fresh connect and uses the protocol versions it lists as the connection's `versions`, so a modern-only or legacy-only server is reached without a failed probe. It is advisory only: a card that cannot be fetched or parsed is ignored, a connect that fails with the card's versions retries once with the connection's normal configuration, explicit `versions` / `versionNegotiation` win (the card is not fetched), and everything after connecting comes from the live server. Also exports `cardProtocolVersions(options)` from `@johnhenry/mcp-query/discovery`.
