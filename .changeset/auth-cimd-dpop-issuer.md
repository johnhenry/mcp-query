---
"@johnhenry/mcp-query": minor
---

OAuth debugging and inbound auth. `instrumentAuthProvider` now records which registration mechanism produced the client (`cimd` or `dcr`), what discovery offered (CIMD support, DCR availability, `iss` support, DPoP algorithms), an `issuerCheck` step once the code-exchange leg starts, and the DPoP key thumbprint only (never the key); `authNote()` lets a host add its own steps. `@johnhenry/mcp-query/server` gains `inboundAuth` on `createGateway` / `createGatewayHandler` plus `applyInboundAuth`: a host-verified bearer token (`requireBearerAuth` / `verifyBearerToken`) is mapped into the call `_meta` (`principal`, `partition`, `authScopes`, `authClientId`) at one choke point covering every registered handler (tasks, skills and extension pass-through included), and caller-supplied values for those keys are dropped.
