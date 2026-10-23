---
"@johnhenry/mcp-query": minor
---

`webMcpToolServer` now passes `annotations` and `title` from `getTools()` descriptors through to `tools/list`, and sends `notifications/tools/list_changed` when the model context fires a `toolchange` event (the listener is removed when the transport closes).
