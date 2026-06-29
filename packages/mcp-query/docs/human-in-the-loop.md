# Human-in-the-loop: the InteractionBroker

Server→client requests that need a human — **sampling approval** and **elicitation**
(and destructive-tool confirms later) — all share one shape: *pending request → surface
to UI → await an approve/deny/edit decision → resolve*. Rather than re-roll that plumbing
per feature, mcp-query routes them through a single `InteractionBroker`.

## Wiring

```ts
import { MCPClient, InteractionBroker, chromeBuiltinAISampling } from "mcp-query";

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
import { useInteractions, useAuditLog } from "mcp-query/react";

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
accept/decline, audit, and round-trips through the client + mock server). Destructive-tool
confirmation (`type: "confirm"`) is modeled in the types but not yet wired into `callTool`.
