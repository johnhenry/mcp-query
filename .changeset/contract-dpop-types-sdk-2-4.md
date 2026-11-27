---
"@johnhenry/mcp-contract": patch
---

`FileOAuthProvider` now type-checks against `@modelcontextprotocol/client` 2.1.0 and later as well as 2.0.0: its `dpop` member takes the installed SDK's own type where the SDK declares one, instead of a narrower local shape that newer SDKs reject. Runtime behaviour is unchanged.
