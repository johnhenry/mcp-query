// Broker + proxy-client wiring for the Agent Approval Queue.
//
// One InteractionBroker mediates every server→client request that needs a human:
//   - sampling   (manualSampling: true ⇒ a human authors the model response)
//   - elicitation (a human fills out the requested form)
//   - response review (reviewResponses: true ⇒ a human can redact the result)
//
// The broker's `policy(ctx)` is driven by a *live* PolicyConfig held here, so the
// Policy editor screen can change verdicts at runtime without rebuilding anything.

import { InteractionBroker } from "mcp-query";
import { makeProxyClient } from "@app-shared";
import { loadPolicy, makePolicyVerdict, type PolicyConfig } from "./policy.js";
import type { AuditEntry } from "mcp-query";

/** Server the demo connects to (advertises trigger-sampling / trigger-elicitation tools). */
export const EVERYTHING_SERVER = "everything";

// Live policy config — mutated by the Policy editor, read by the broker on every decision.
let policyConfig: PolicyConfig = loadPolicy();
export function getPolicyConfig(): PolicyConfig {
  return policyConfig;
}
export function setPolicyConfig(next: PolicyConfig): void {
  policyConfig = next;
}

/** Simple console audit sink (also visible in the in-app Audit timeline). */
function onAudit(entry: AuditEntry): void {
  // eslint-disable-next-line no-console
  console.debug("[audit]", entry.outcome, entry.type, entry.server, entry.reason ?? "");
}

export const broker = new InteractionBroker({
  // Human-as-model: a person authors the sampling response in the approval UI.
  manualSampling: true,
  // Approved sampling results also get a response-review (redaction) step.
  reviewResponses: true,
  // Per-request trust policy, driven by the live config above.
  policy: makePolicyVerdict(getPolicyConfig),
  onAudit,
});

export const client = makeProxyClient({
  servers: {
    [EVERYTHING_SERVER]: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
  },
  broker,
  clientInfo: { name: "mcp-approvals", version: "0.0.1", title: "Agent Approval Queue" },
});
