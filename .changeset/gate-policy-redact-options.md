---
"@johnhenry/mcp-gate": minor
---

Additive options so an embedding gate can use `./policy` and `./redact` directly (#70): `emptyAllow` (`"ignore"` treats `allow: []` as no allow list), `scope: "tool"` (globs over the bare tool name, optionally per server), `explainPolicy()` returning `{ decision, rule? }` with the list and glob that decided, redact rule `flags`, and a `defaultReplacement` option. Defaults keep the current behaviour.
