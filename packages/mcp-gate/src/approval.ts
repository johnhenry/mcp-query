// Human-in-the-loop approval for the gate (#43). The gate's policy verdicts are
// allow | deny | approve; "approve" parks the operation here until a person (via the
// InteractionBroker's queue) or a programmatic `handler` decides. Node-only entry code
// (imported by ./index.ts, never by ./index.browser.ts), though it has no Node deps itself.

import { InteractionBroker } from "@johnhenry/mcp-query";
import { AuthorizationError, type AuthzRequest } from "@johnhenry/mcp-query/server";
import type { ApprovalConfig, ApprovalRequest } from "./config.js";

/** Build the `onApprove` hook for `authorize()` plus the broker backing it. */
export function createApproval(cfg: ApprovalConfig): {
  broker: InteractionBroker;
  onApprove: (req: AuthzRequest) => Promise<void>;
} {
  // A caller-supplied broker keeps its own policy/audit; otherwise the broker asks for
  // everything (the broker's default), so the only way through is an explicit decision.
  const broker = cfg.broker ?? new InteractionBroker();

  if (cfg.handler) {
    const handler = cfg.handler;
    const seen = new Set<number>();
    broker.subscribe(() => {
      for (const it of broker.list()) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        const p = it.payload as { request?: ApprovalRequest } | undefined;
        if (!p?.request) continue; // not one of ours — leave it for the broker's own UI
        // A throwing/rejecting/odd handler denies: approval fails closed.
        Promise.resolve()
          .then(() => handler({ ...p.request!, id: it.id }))
          .then(
            (d) => broker.resolve(it.id, d === "allow" ? { action: "approve" } : { action: "deny", reason: "denied by approval handler" }),
            (e) => broker.resolve(it.id, { action: "deny", reason: `approval handler failed: ${e instanceof Error ? e.message : String(e)}` }),
          );
      }
    });
  }

  const onApprove = async (req: AuthzRequest) => {
    const request: ApprovalRequest = {
      id: 0,
      kind: req.kind,
      server: req.server,
      target: req.target,
      args: req.args,
      destructive: req.destructive,
      readOnly: req.readOnly,
      context: req.context,
    };
    const { verdict, decision } = await broker.gate(
      req.kind === "call" ? "tool-call" : req.kind,
      req.server,
      // `tool`/`args`/`destructive` mirror the shape existing broker policies already match on.
      { tool: req.target, args: req.args, destructive: req.destructive, request },
      {
        autoApprove: { action: "approve" },
        autoDeny: { action: "deny", reason: "policy" },
        timeoutMs: cfg.timeoutMs,
      },
    );
    if (verdict === "auto-deny" || verdict === "denied") {
      const why = decision?.reason ? ` (${decision.reason})` : "";
      throw new AuthorizationError(`denied: ${req.kind} ${req.server}.${req.target} not approved${why}`);
    }
  };
  return { broker, onApprove };
}
