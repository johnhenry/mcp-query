# @mcp-query/approvals — Agent Approval Queue

A human-in-the-loop oversight UI for MCP agents, built on
[`mcp-query`](../../packages/mcp-query)'s **`InteractionBroker`**.

Agents (via MCP servers) propose actions that need a human: an **LLM sampling**
request, a structured **elicitation** form, or a **confirm**. Every such request
is intercepted by one broker, surfaced in a single approval queue, and a human
**approves / denies / edits** it. Every decision is recorded to an exportable
**audit trail**, and a **trust policy** can auto-allow / auto-deny / ask per
interaction type and server.

## What it demonstrates

- **Manual sampling** (`manualSampling: true`) — the human *authors* the model
  response in the UI (the MCP Inspector pattern), and can edit the prompt
  messages before approving.
- **Response review** (`reviewResponses: true`) — approved sampling results get a
  second redaction pass before they return to the agent.
- **Elicitation** — renders the server's `requestedSchema` as a form (via
  `@app-shared`'s `SchemaForm`) and returns the submitted content.
- **Policy** — a `policy(ctx)` callback driven by a live, editable, localStorage-
  persisted rule set.
- **Audit** — an outcome-colored timeline with **NDJSON export**.

## Run

From the monorepo root:

```bash
npm run dev -w @mcp-query/approvals
```

This launches two processes (via `concurrently`):

- **proxy** — `tsx ../shared/src/proxy-cli.ts`, a WebSocket bridge on
  `ws://127.0.0.1:6280` that dials MCP servers (here: `@modelcontextprotocol/server-everything`
  over stdio) on the browser's behalf.
- **web** — Vite dev server on `http://localhost:5173`.

The proxy prints a tokenized URL on startup, e.g.:

```
  ⬡ mcp-query proxy  ws://127.0.0.1:6280
  → Open:  http://localhost:5173/?proxyToken=<token>&proxyPort=6280
```

**Open that printed URL** (the `proxyToken` query param is required — the client
reads it to authenticate to the proxy). The header should show **Connected** once
`server-everything` is ready.

Other scripts:

```bash
npm run typecheck -w @mcp-query/approvals
npm test          -w @mcp-query/approvals
npm run build     -w @mcp-query/approvals
```

## How it's wired

```ts
import { InteractionBroker } from "mcp-query";
import { makeProxyClient, AppProvider } from "@app-shared";

const broker = new InteractionBroker({
  manualSampling: true,    // human authors sampling responses
  reviewResponses: true,   // approved results get a redaction pass
  policy: (ctx) => policyVerdict(ctx),  // allow | deny | ask
  onAudit: (e) => {},
});

const client = makeProxyClient({
  servers: { everything: { transport: "stdio", command: "npx",
                           args: ["-y", "@modelcontextprotocol/server-everything"] } },
  broker,  // makeProxyClient passes this through as MCPClient's `interactions`
});
void client.connect();

// <AppProvider client={client}> … </AppProvider>
```

In the UI, `useInteractions()` reads the pending queue and `resolve(id, decision)`
settles each one; `useAuditLog()` reads the trail. See `src/broker.ts`,
`src/App.tsx`, and `src/components/`.

## Triggering an interaction

Use the **"Simulate agent action"** buttons in the header:

- **Sampling** → calls `server-everything`'s `trigger-sampling-request` tool,
  which makes the server send a real `sampling/createMessage` request back to the
  client. The broker enqueues it as a manual sampling interaction.
- **Elicitation** → calls `trigger-elicitation-request`, which sends a real
  `elicitation/create` request with a rich `requestedSchema`. Rendered as a form.
- **Confirm** → a synthetic allow/deny prompt.

If those tools aren't advertised (older server build / offline), the app falls
back to injecting a synthetic interaction directly through the broker's public
`handleSampling` / `handleElicitation` entry points, so the UI is always
demonstrable. (`server-everything` only registers the sampling/elicitation tools
when the client advertises those capabilities — which it does here, because the
broker installs `sampling` + `elicitation` handlers.)

## Screens

1. **Queue** — one card per pending interaction (type / server / age).
   - *Sampling (request):* shows + lets you edit the prompt messages; in manual
     mode you author the assistant reply. Approve sends `editedMessages` +
     `editedResult`.
   - *Sampling (response review):* shows the model result; edit to redact, approve
     sends `editedResult`.
   - *Elicitation:* a `SchemaForm` from `requestedSchema`; submit sends `content`.
   - *Confirm:* allow / deny.
   - Every card has **Approve** (green) / **Deny** (red) with an optional reason.
2. **Audit** — an outcome-colored timeline (approved/denied/auto/error) with an
   **Export NDJSON** button (one audit entry per line).
3. **Policy** — compose verdict rules (`allow` / `deny` / `ask`) per interaction
   **type** and/or **server**, plus a default. First match wins. Changes are
   applied to the broker live and persisted to `localStorage`. A live preview
   shows the resulting verdict for each interaction type.

## The approve / deny / edit + audit + policy flow

```
agent (MCP server)  ──sampling/elicitation──▶  InteractionBroker
                                                   │
                                          policy(ctx) verdict?
                                   ┌──────────┼───────────┐
                                allow        ask         deny
                                   │           │           │
                              auto-allow   enqueue →    auto-deny
                              (audit)      Queue card    (audit)
                                              │
                               human: approve / deny  (+ edit, + reason)
                                              │
                                    resolve(id, decision)
                                              │
                                   result returns to agent
                                              │
                                        audit entry  ──▶  Audit timeline / NDJSON
```

## Tests

- `test/policy.test.ts` — unit tests for the pure policy evaluator (allow / deny /
  ask by type & server, wildcard matching, first-match-wins, live config) and the
  NDJSON export.
- `test/broker.integration.test.ts` — drives a real `InteractionBroker` (no React):
  enqueues manual sampling + elicitation interactions, calls `resolve()` with
  approve/deny, and asserts the call settles and the audit log records the right
  outcome. Also covers response-review redaction and an auto-allow policy.
