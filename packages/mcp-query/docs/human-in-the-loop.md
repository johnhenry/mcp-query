# Human-in-the-loop: the InteractionBroker

Server→client requests that need a human — **sampling approval** and **elicitation**
(and destructive-tool confirms later) — all share one shape: *pending request → surface
to UI → await an approve/deny/edit decision → resolve*. Rather than re-roll that plumbing
per feature, mcp-query routes them through a single `InteractionBroker`.

## Wiring

```ts
import { MCPClient, InteractionBroker, chromeBuiltinAISampling } from "@johnhenry/mcp-query";

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
import { useInteractions, useAuditLog } from "@johnhenry/mcp-query/react";

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

## Delivery: server-initiated requests vs multi-round-trip (2026-07-28)

How a server's interaction request REACHES the broker depends on the connection's
protocol era — but the broker surface is identical for both:

- **Legacy (2025-x) connections**: the server pushes a real server→client JSON-RPC
  request (`elicitation/create`, `sampling/createMessage`, `roots/list`); the
  registered handler answers it.
- **Modern (2026-07-28) connections**: server→client requests no longer exist.
  The server answers `tools/call`/`resources/read`/`prompts/get` with an
  `input_required` result embedding the same request objects; the SDK's
  multi-round-trip driver fulfils them through the SAME registered handlers —
  i.e. through the broker — then retries the original call with the collected
  `inputResponses` and the server's opaque `requestState`, up to
  `inputRequired.maxRounds` rounds (`MCPClientConfig.inputRequired`).

The policy gate, approval queue, edit/redact hooks, and audit trail apply
identically to both paths; UIs built on `useInteractions()` need no changes.

### Elicitation modes

`ElicitationRequest` is a `form | url` union:

- **form** — `{ message, requestedSchema }`; `InteractionDecision.content`
  carries the user's structured input back.
- **url** — `{ message, url }`: the server wants the user sent to `url`
  out-of-band (e.g. an OAuth flow). On 2026-07-28 the server learns the outcome
  when the client retries the original call — there is no `elicitationId` or
  completion notification anymore; servers correlate across retries via their
  own identifier inside `requestState`.

Both modes are advertised whenever an elicitation handler is registered
(`elicitation: { form: {}, url: {} }`) — servers gate each mode on its own
sub-capability.

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
accept/decline, audit, and legacy-era round-trips) and `test/era.test.ts` (the same
round-trips through the modern-era multi-round-trip driver, incl. url mode and
policy-deny inside a round). Destructive-tool confirmation (`type: "confirm"`) is
modeled in the types but not yet wired into `callTool`.

Deprecation note (SEP-2577): the Sampling and Roots features are deprecated as of
2026-07-28 (≥12-month window). The broker keeps supporting both — they remain the
vocabulary of embedded multi-round-trip requests — but new designs should prefer
integrating LLM provider APIs directly over sampling.
