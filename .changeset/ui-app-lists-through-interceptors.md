---
"@johnhenry/mcp-query-ui": minor
---

An app's opted-in `resources/list` and `prompts/list` now run through the client's interceptor chain (`client.discover`, principal `mcp-app:<uri>`), so mcp-gate policy, audit and any user interceptor apply to them and a deny or filter is reflected in the app's list. Still off by default, still gated first by the InteractionBroker `confirm` step, still recorded in `state.calls`; a client without `discover` falls back to its synchronous lists. A tool the gate policy hides from `listTools` is still refused by the policy (`denied`) rather than reported as unknown.
