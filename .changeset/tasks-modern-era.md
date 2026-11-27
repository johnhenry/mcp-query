---
"@johnhenry/mcp-query": minor
---

Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663) now works on 2026-07-28 connections when the installed `@modelcontextprotocol/client` is 2.3.0 or newer: `callToolTask`, `getTask`, `cancelTask` and `input_required` rounds via `tasks/update`. The unconditional modern-era gate is replaced by a runtime probe of the SDK, so SDK 2.0.x (still within the `^2.0.0` peer range) fails fast with an accurate message that names the 2.3.0 requirement. Modern-era task status is poll-only because the SDK client has no `taskIds` filter for `subscriptions/listen`.
