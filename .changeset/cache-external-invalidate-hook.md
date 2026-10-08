---
"@johnhenry/mcp-query": minor
---

`MCPCache.onExternalInvalidate(listener)` (reachable as `client.cache.onExternalInvalidate`): register a listener on an already-constructed cache that fires on every tag/key invalidation, protocol-driven or declared, whether or not a local entry matches. Returns an unsubscribe function; a constructor-supplied `events.onExternalInvalidate` keeps working. Exports the `ExternalInvalidateEvent` type (#24).
