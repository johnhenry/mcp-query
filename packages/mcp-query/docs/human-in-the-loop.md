# Human-in-the-loop: the InteractionBroker

Server→client requests that need a human — **sampling approval** and **elicitation**
(and destructive-tool confirms later) — all share one shape: *pending request → surface
to UI → await an approve/deny/edit decision → resolve*. Rather than re-roll that plumbing
per feature, mcp-query routes them through a single `InteractionBroker`.

## Wiring

```ts
import { MCPClient, InteractionBroker, chromeBuiltinAISampling } from "@johnhenry/mcpq";

const broker = new InteractionBroker({
  model: chromeBuiltinAISampling(),          // runs the LLM for sampling requests
  policy: ({ server, type }) =>              // per-request trust verdict
    server === "fs" ? "allow" : "ask",       // "allow" | "deny" | "ask"
  reviewResponses: true,                     // also review/redact the model's output
  onAudit: (e) => console.log("[host]", e),  // audit sink (also kept in-memory)
});

const client = new MCPClient({ servers: { /* … */ }, interactions: broker });
```

Passing `interactions` makes the client route **sampling + elicitation** through the
broker with server context; `roots` and any other handlers pass through unchanged.
Sampling is advertised only if the broker has a `model`.

## Decisions

The UI settles each pending interaction with an `InteractionDecision`:

| Field | Applies to | Effect |
|---|---|---|
| `action: "approve" \| "deny"` | all | allow or reject the request |
| `editedMessages` | sampling **request** phase | rewrite the prompt before it reaches the model |
| `editedResult` | sampling **response** phase | redact/replace the result before the *server* sees it (needs `reviewResponses`) |
| `content` | elicitation | the structured input the user supplied |

## Rendering the queue in React

```tsx
import { useInteractions, useAuditLog } from "@johnhenry/mcpq/react";

function ApprovalCenter() {
  const { interactions, resolve } = useInteractions();
  return (
    <>
      {interactions.map((i) => (
        <dialog key={i.id} open>
          <p><b>{i.server}</b> requests <code>{i.type}</code> ({i.phase})</p>
          <pre>{JSON.stringify(i.payload, null, 2)}</pre>
          <button onClick={() => resolve(i.id, { action: "approve" })}>Approve</button>
          <button onClick={() => resolve(i.id, { action: "deny" })}>Deny</button>
        </dialog>
      ))}
    </>
  );
}
```

`useAuditLog()` returns the trail (`{ server, type, outcome, reason, at }`) for an
oversight panel. The broker's audit entries are also mirrored into devtools as
`host-call` events.

## Elicitation: form vs url mode

`elicitation/create` requests come in two shapes (`ElicitationRequest` in
[`src/core/types.ts`](../src/core/types.ts)):

- **form** (the original shape) — `{ message, requestedSchema }`. The UI renders fields;
  `InteractionDecision.content` carries what the user typed back to the server.
- **url** — `{ message, url, elicitationId }`. The server wants the user sent to `url`
  out-of-band (e.g. to finish an OAuth flow on its own site) rather than filling out a
  form. Approving the pending interaction just tells the server "I'll show it" — there's
  no `content` to return. The server later confirms real completion with a
  `notifications/elicitation/complete { elicitationId }`, which the broker records as an
  audit entry (`outcome: "completed"`, `reason: elicitationId`) via
  `broker.completeElicitation(server, elicitationId)` — wired automatically whenever a
  broker is passed to `MCPClient`. Use this to clear a "waiting on `<url>`" UI state once
  the trail shows the matching `elicitationId` as completed.

Both modes must be explicitly advertised — `clientCapabilities()` sends
`elicitation: { form: {}, url: {} }` whenever a `HostHandlers.elicitation` handler is
registered (mcp-query supports both), since servers gate each mode on its own
sub-capability and reject the request otherwise.

## Trust policy

`policy({ server, type, payload }) => "allow" | "deny" | "ask"` runs before any human is
involved:

- `"allow"` — auto-approve, never queue (e.g. a trusted local server).
- `"deny"` — auto-reject, never queue.
- `"ask"` — queue for a human (the default for everything when no policy is given).

This is where you encode "auto-approve my filesystem server, always-ask the remote one,"
rate limits, or content pre-filters.

## Status

Implemented in [`src/core/interactions.ts`](../src/core/interactions.ts); hooks in
[`src/react/interactions.ts`](../src/react/interactions.ts). Covered by
`test/interactions.test.ts` (policy verdicts, prompt-edit, response-redaction, elicitation
accept/decline + url-mode + completion, audit, and round-trips through the client + mock
server). Destructive-tool confirmation (`type: "confirm"`) is modeled in the types but not
yet wired into `callTool`.

### Spec tracking (MCP 2026-07-28)

The MCP spec finalizing 2026-07-28 formally deprecates sampling/roots/logging
(non-breaking, ~1 year grace period through 2027-05-21 — see SEP-2577) and, via
**SEP-2322**, restructures elicitation. This release adds the piece of that restructuring
that's actually shipped in `@modelcontextprotocol/sdk` today — url-mode elicitation
(above). The other part SEP-2322 describes, a stateless `InputRequiredResult`/
`inputResponses` retry pattern at the tool-call level, is **not yet exposed by the SDK**
(checked against `@modelcontextprotocol/sdk@1.29.0`, the latest as of this writing) — pick
that back up once the SDK ships it. No action is needed yet for the sampling/roots/logging
deprecations themselves beyond this note; revisit before the grace period ends.
