---
"@johnhenry/mcp-query": minor
"@johnhenry/mcp-gate": minor
---

Gateway MRTR pass-through (#82, slice 1). `createGateway` / `createGatewayHandler` take `interactions: "answer" | "forward" | "deny"` (or `{ default, upstreams }`): with `"forward"`, an upstream `input_required` result on a 2026-07-28 connection is returned to the gateway's consumer (`requestState` untouched) and the consumer's retry is routed back to the same upstream; the default `"answer"` is unchanged. `MCPClient.callTool` / `getPrompt` accept `interaction` (manual MRTR), an interim `input_required` result is never cached, and `CallAuditEntry` gains `interaction`. `@johnhenry/mcp-gate` adds the `interactions` config key, a fail-closed `urlElicitation` allow/deny host policy for forwarded URL-mode elicitations, and redaction that leaves `requestState` alone.
