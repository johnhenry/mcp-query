---
"@johnhenry/mcp-gate": minor
---

`interactions: "forward"` covers `resources/read` and 2025-era upstreams (their elicitation is relayed to the consumer, with `redact`, `urlElicitation`, `answerPolicy` and audit applied on both hops); new `interactionTimeoutMs` and `createRequestGuard`. `subscriptions/listen` is refused without a verified token when `inboundAuth.required`, and a tool the gate hides being added upstream no longer triggers a `list_changed`. Documented in the README.
