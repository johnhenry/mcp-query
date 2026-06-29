# Building Inspector-style tooling on mcp-query

The [MCP Inspector](https://github.com/modelcontextprotocol/inspector) is a non-agentic
MCP app — exactly mcp-query's target. Most of it (tools/resources/prompts tabs,
subscriptions, completion, notifications, elicitation, roots, ping, log level) is existing
hooks. These four additions close the remaining debugging gaps. (The one piece mcp-query
deliberately does **not** provide is the Inspector's stdio **proxy** — that's deployment
infra for browsers, not a data layer; in Node/Electron you use stdio transports directly.)

## 1. Raw JSON-RPC message log

When a `devtools` sink is configured, every JSON-RPC message — both directions — is
emitted as `request` / `response` / `notification` events (with `dir`, method, id, and
response timing). This is the Inspector's defining "see every message" feature.

```ts
import { DevtoolsHub } from "mcp-query/devtools";

const hub = new DevtoolsHub();
const client = new MCPClient({ servers, devtools: hub });
// hub.events() now includes:
//   { type: "request",  dir: "out", method: "tools/call", id: "3", params }
//   { type: "response", dir: "in",  id: "3", ok: true, ms: 12 }
//   { type: "notification", dir: "in", method: "notifications/message", params }
```

The `MCPDevtools` panel renders this as a live message log. Instrumentation is zero-cost
when no devtools sink is set. To tap a transport directly: `instrumentTransport(t, onTraffic)`.

## 2. Manual (human-as-model) sampling

The Inspector lets a developer *hand-author* a sampling response instead of running an LLM.
Set `manualSampling` on the broker — sampling is advertised, and each request becomes an
interaction the human resolves with `editedResult`:

```ts
const broker = new InteractionBroker({ manualSampling: true });
const client = new MCPClient({ servers, interactions: broker });

// In the approval UI, pending sampling interactions have `manual: true`:
resolve(i.id, {
  action: "approve",
  editedResult: { role: "assistant", content: { type: "text", text: "…authored…" }, model: "human", stopReason: "endTurn" },
});
```

The bundled devtools panel already renders a "send" composer for `manual` interactions.

## 3. Auth / OAuth debugging surface

mcp-query delegates OAuth to the SDK's `authProvider` (configured on the transport). To
*observe* the handshake, wrap your provider with `instrumentAuthProvider` — it records each
step (client registration, token read/write, the authorization redirect, PKCE verifier)
with secrets redacted, and exposes `authSteps()`:

```ts
import { instrumentAuthProvider } from "mcp-query";

const provider = instrumentAuthProvider(myOAuthProvider, (step) => hub.emit({ type: "auth", member: step.member, phase: step.phase }));
const client = new MCPClient({
  servers: { github: { transport: () => new StreamableHTTPClientTransport(url, { authProvider: provider }) } },
});
// later: provider.authSteps() → [{ member: "redirectToAuthorization", detail: { authorizationUrl } }, …]
```

Token values are never logged — only `{ hasAccessToken, hasRefreshToken }`.

## 4. CLI mode + per-request timeouts

A scripting/CI CLI (`mcp-query-inspect`, or `npm run inspect`) dispatches any method and
prints JSON:

```bash
mcp-query-inspect --command npx --args "-y @modelcontextprotocol/server-everything" --method tools/list
mcp-query-inspect --command … --method tools/call --tool echo --arg message=hi --arg count=3
mcp-query-inspect --url https://mcp.example.com --transport http --method resources/list
mcp-query-inspect --command … --method ping
```

Supported `--method`: `tools/list`, `tools/call`, `resources/list`,
`resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, `ping`,
`complete`. `--arg key=value` repeats; values are JSON-parsed (falling back to string).

Per-request timeouts (Inspector's `MCP_SERVER_REQUEST_TIMEOUT` etc.) are exposed on reads
and calls:

```ts
await client.callTool("fs.slow", args, {
  requestOptions: { timeout: 5_000, resetTimeoutOnProgress: true, maxTotalTimeout: 60_000 },
});
await client.readResource(uri, { requestOptions: { timeout: 5_000 } });
```
