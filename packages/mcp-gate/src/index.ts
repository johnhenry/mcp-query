// mcp-gate — a config-driven MCP security/policy proxy. Assembles an mcp-query MCPClient
// (with an interceptor stack: authorize → approve → circuit-break → rate-limit → redact) behind a
// gateway Server, so an agent sees ONE governed MCP endpoint fronting many upstreams.

import type { InteractionBroker } from "@johnhenry/mcp-query";
import { createGateway } from "@johnhenry/mcp-query/server";
import { policyListAnnotator, policyListFilter, type GateConfig, type GateUpstream } from "./config.js";
import { buildGateClient } from "./client.js";
import { resolveUpstream } from "./upstream.js";
import { validateGateUpstream } from "./validate.js";
import type { MCPClient } from "@johnhenry/mcp-query";

export type { ApprovalConfig, ApprovalRequest, GateConfig, GatePolicy, GatePolicyRules, PolicyOptions, PolicyScope, PolicyRule, PolicyDecision, GateUpstream, StdioUpstreamSpec, HttpUpstreamSpec } from "./config.js";
export type { RedactRule, RedactOptions } from "./redact.js";
export { redact, redactValue } from "./redact.js";
export { compilePolicy, explainPolicy, policyListAnnotator, policyListFilter } from "./config.js";
export { resolveUpstream } from "./upstream.js";
export { resolveHttpUpstream } from "./upstream-http.js";
export { createGateClient, type GateClient } from "./client.js";
export { validateGateConfig } from "./validate.js";
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
  close(): Promise<void>;
}

/** Build (and connect) a gate from config. Connect `gate.server` to a transport to serve. */
export async function createGate(config: GateConfig): Promise<Gate> {
  const parts = await buildGateClient(config, resolveUpstream);
  const { client } = parts;

  const server = createGateway(client, {
    namespace: config.namespace ?? true,
    // Hide name-denied tools/prompts from discovery (call-time policy still enforces all rules).
    filter: config.policy ? policyListFilter(config.policy, config.approval?.discovery) : undefined,
    // approval.discovery "annotated": flag approve-gated items with _meta.requiresApproval.
    annotate: config.policy ? policyListAnnotator(config.policy, config.approval?.discovery) : undefined,
  });

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
    close: async () => {
      await server.close().catch(() => {});
      await client.close();
    },
  };
}
