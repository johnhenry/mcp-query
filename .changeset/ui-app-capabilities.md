---
"@johnhenry/mcp-query-ui": minor
---

Opt-in app capabilities, all off by default: `appCapabilities: { resourcesList, promptsList, sampling, updateModelContext }` on `createAppHost`, with `interactions` (an `InteractionBroker`, defaulting to `client.interactions`), `onUpdateModelContext` and `approvalTimeoutMs`. A request for a capability that is off is refused with a clear error and recorded as `denied` in `state.calls`; enabled ones are tracked there too (`AppCall.kind` gains `resources-list | prompts-list | sampling | model-context`). Sampling needs a broker so policy or a human approves it, and is discouraged because it is deprecated in the core protocol (SEP-2577). `prompts/get` is not offered because ext-apps' `AppBridge` has no handler for it.
