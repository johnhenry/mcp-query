---
"@johnhenry/mcp-gate": minor
---

`authorize`, `redact` and `audit` now see `prompts/get` (kind `prompt`, matched by the existing `server.prompt` globs), the skills calls (kind `skill`) and catalog views (kind `list`). Declarative policies leave `list` and `skill` allowed, so existing configs keep working; function policies receive every kind. Name-denied items are hidden from the client's own `listTools()`/`listResources()`/`listPrompts()` (library mode included) the way the gateway already hides them, and `approval.discovery: "annotated"` stamps `_meta.requiresApproval` there. `redact` scrubs prompt results and skill file text (marking the file `verified: false`) and leaves catalog names alone. Requires the `@johnhenry/mcp-query` version carrying these operation kinds.
