---
"@johnhenry/mcp-gate": minor
"@johnhenry/mcp-query": minor
---

Forwarded interaction rounds (`interactions: "forward"`) now guard the consumer's answers on their way upstream. mcp-gate applies its `redact` rules to `inputResponses` (never to `requestState`, which stays byte-for-byte), and a new `answerPolicy` config (rules or a function receiving an `AuthzRequest` with `kind: "answer"`) gives allow / deny / approve a say per answer: a denied answer becomes `{ action: "decline" }`. With no `answerPolicy`, answers are allowed as before. The answer hop's audit entry records `redactedFields` and `declined` (names only). mcp-query adds the `guardAnswers` gateway option and its types, `AuthzRequest.kind: "answer"`, and the audit fields. It also fixes the gateway's `-32004` `GatewayUpstreamCapabilityError` translation, which never fired because `MCPClient` wraps the SDK error in an `MCPError` first: consumers of an `answer`/`deny` gateway now get `-32004` instead of the upstream's raw `-32021` (forwarding gateways keep `-32021`, which names the consumer's own missing capability).
