---
"@johnhenry/mcp-gate": minor
---

HTTP upstreams accept `auth: { type: "client_credentials", ... }` and `auth: { type: "enterprise", ... }` next to `getToken`, with secrets by reference only (`{ env }` or `{ get }`; `validateGateConfig` rejects inline secret strings), a required `issuer` that credentials are bound to, and an expiry-aware, single-flight token cache that never reaches audit entries. Enterprise-managed authorization is built against a mock identity provider and is untested against a real one. New `inboundAuth` config and `gate.handler()` let you front the gate with the SDK's `requireBearerAuth` / `verifyBearerToken` and use the verified principal in `policy` and `partitionFrom`.
