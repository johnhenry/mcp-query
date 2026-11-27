// mcp-gate — a config-driven MCP security/policy proxy. Assembles an mcp-query MCPClient
// (with an interceptor stack: authorize → approve → circuit-break → rate-limit → redact) behind a
// gateway Server, so an agent sees ONE governed MCP endpoint fronting many upstreams.

import type { InteractionBroker } from "@johnhenry/mcp-query";
import { createGateway, createGatewayHandler, type GatewayHandlerOptions } from "@johnhenry/mcp-query/server";
import { createAnswerGuard } from "./interaction.js";
import { policyListAnnotator, policyListFilter, policySkillFilter, type GateConfig, type GateUpstream } from "./config.js";
import { buildGateClient } from "./client.js";
import { resolveUpstream } from "./upstream.js";
import { validateGateUpstream } from "./validate.js";
import type { MCPClient } from "@johnhenry/mcp-query";

export type { ApprovalConfig, ApprovalRequest, GateConfig, GatePolicy, GatePolicyRules, AnswerPolicy, AnswerPolicyRules, PolicyOptions, PolicyScope, PolicyRule, PolicyDecision, GateUpstream, StdioUpstreamSpec, HttpUpstreamSpec, SecretRef, UpstreamAuth, ClientCredentialsAuth, EnterpriseAuth } from "./config.js";
export type { RedactRule, RedactOptions } from "./redact.js";
export { redact, redactValue, redactTracked } from "./redact.js";
export { compilePolicy, explainPolicy, policyListAnnotator, policyListFilter, policySkillFilter } from "./config.js";
export { resolveUpstream } from "./upstream.js";
export { resolveHttpUpstream } from "./upstream-http.js";
export { createGateClient, type GateClient } from "./client.js";
export { tokenSourceFor, cachedTokenSource, type UpstreamTokenSource } from "./upstream-auth.js";
export { validateGateConfig } from "./validate.js";
export { gateServerCard, gateCardUrl, createGateCardHandler, GATE_CARD_META_KEY, type GateCardConfig, type GateServerCard } from "./card.js";
export { urlElicitationPolicy, compileUrlPolicy, createAnswerGuard, compileAnswerPolicy, type UrlElicitationPolicy, type AnswerGuardOptions } from "./interaction.js";
export { CircuitOpenError } from "@johnhenry/mcp-query/server";

export interface Gate {
  /** The gateway re-server (a v2-SDK Server — mcp-query moved to @modelcontextprotocol/server). Connect it to a transport (stdio / Streamable HTTP) to serve it — optional, see "library mode" in the README. */
  server: ReturnType<typeof createGateway>;
  /** The underlying mcp-query client fronting the upstreams. */
  client: MCPClient;
  /** Connect and register a new upstream on a live gate. Throws if `name` already exists or the spec is malformed. */
  addUpstream(name: string, upstream: GateUpstream): Promise<void>;
  /** Disconnect and remove an upstream: prunes its rateLimit/circuitBreaker state and pushes list_changed. No-op if `name` doesn't exist. */
  removeUpstream(name: string): Promise<void>;
  /** Atomic remove+add — swap an upstream's connection (e.g. rotate a URL/command) without disturbing others. */
  updateUpstream(name: string, upstream: GateUpstream): Promise<void>;
  /** The InteractionBroker holding pending approvals ("approve" verdicts). Undefined unless `config.approval` is set. List/resolve here from your UI. */
  approvals?: InteractionBroker;
  /**
   * A modern (2026-07-28) HTTP handler over this gate: the same policy, redaction and inbound-auth
   * settings as `server`, served through `handler.fetch(request, { authInfo })`. Front it with the
   * SDK's `requireBearerAuth` and pass the verified `AuthInfo` along (see the README, "Inbound
   * authentication"). Close it before the gate.
   */
  handler(opts?: Omit<GatewayHandlerOptions, "namespace" | "interactions" | "inboundAuth" | "guardAnswers" | "filter" | "annotate">): ReturnType<typeof createGatewayHandler>;
  close(): Promise<void>;
}

/** Build (and connect) a gate from config. Connect `gate.server` to a transport to serve. */
export async function createGate(config: GateConfig): Promise<Gate> {
  const parts = await buildGateClient(config, resolveUpstream);
  const { client } = parts;

  const gatewayOptions = {
    namespace: config.namespace ?? true,
    interactions: config.interactions,
    inboundAuth: config.inboundAuth,
    // The consumer's answers to forwarded input requests: answerPolicy, then `redact` (#100).
    // Also covers `tasks/update` answers (the tasks extension), which are not gated by `interactions`.
    guardAnswers: createAnswerGuard({
      redact: config.redact,
      policy: config.answerPolicy,
      onApprove: parts.onApprove,
      audit: parts.audit,
      toolHints: (s, t) => {
        const def = client.listTools(s).find((x) => x.name === t);
        return { destructive: def?.annotations?.destructiveHint === true, readOnly: def?.annotations?.readOnlyHint === true };
      },
    }),
    extensions: config.extensions,
    // Task ids are bound to the same tenant partition the gate isolates rate limits by.
    partitionFrom: config.partitionFrom ?? ((meta) => (typeof meta?.partition === "string" ? meta.partition : undefined)),
    skillFilter: config.policy ? policySkillFilter(config.policy) : undefined,
    audit: parts.audit,
    // Hide name-denied tools/prompts from discovery (call-time policy still enforces all rules).
    filter: config.policy ? policyListFilter(config.policy, config.approval?.discovery) : undefined,
    // approval.discovery "annotated": flag approve-gated items with _meta.requiresApproval.
    annotate: config.policy ? policyListAnnotator(config.policy, config.approval?.discovery) : undefined,
  };
  const server = createGateway(client, gatewayOptions);

  const addUpstream = async (name: string, upstream: GateUpstream) => {
    validateGateUpstream(name, upstream);
    await client.addServer(name, resolveUpstream(upstream));
    // tools/resources/prompts list_changed already fires: addServer shares the same
    // capability-listener wiring an eager-connected server gets at construction time.
  };
  const removeUpstream = async (name: string) => {
    await client.removeServer(name); // no-op if `name` doesn't exist
    parts.dropServer(name);
    // Unlike addServer, removeServer doesn't fire capability-changed itself — push explicitly.
    await Promise.all([server.sendToolListChanged(), server.sendResourceListChanged(), server.sendPromptListChanged()].map((p) => p.catch(() => {})));
  };
  const updateUpstream = async (name: string, upstream: GateUpstream) => {
    await removeUpstream(name);
    await addUpstream(name, upstream);
  };

  return {
    server,
    client,
    addUpstream,
    removeUpstream,
    updateUpstream,
    approvals: parts.approvals,
    handler: (opts) => createGatewayHandler(client, { ...opts, ...gatewayOptions }),
    close: async () => {
      await server.close().catch(() => {});
      await client.close();
    },
  };
}
