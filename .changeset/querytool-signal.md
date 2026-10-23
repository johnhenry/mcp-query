---
"@johnhenry/mcp-query": minor
---

`queryTool(name, args, { signal })` lets a caller cancel its own wait: that caller's promise rejects with an `AbortError` when its signal fires (immediately, without starting a request, if it is already aborted). The underlying request, which is de-duplicated across callers, is cancelled only once every caller waiting on it has aborted; a cancelled fetch no longer marks the cache entry as errored. `MockMCPServer` tool handlers also receive the request's `signal` on their context.
