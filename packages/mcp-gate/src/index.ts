// mcp-gate — a config-driven MCP security/policy proxy. Assembles an mcp-query MCPClient
// (with an interceptor stack: authorize → circuit-break → rate-limit → redact) behind a
// gateway Server, so an agent sees ONE governed MCP endpoint fronting many upstreams.

import { MCPClient, type RequestInterceptor } from "../../mcp-query/src/index.js";
import { authorize, circuitBreaker, rateLimit, createGateway } from "../../mcp-query/src/server/index.js";
import { redact } from "./redact.js";
import { compilePolicy, policyListFilter, resolveUpstream, type GateConfig } from "./config.js";
import { validateGateConfig } from "./validate.js";

export type { GateConfig, GatePolicy, GatePolicyRules, GateUpstream, StdioUpstreamSpec, HttpUpstreamSpec } from "./config.js";
export type { RedactRule } from "./redact.js";
export { redact } from "./redact.js";
export { compilePolicy, policyListFilter, resolveUpstream } from "./config.js";
export { validateGateConfig } from "./validate.js";

export interface Gate {
  /** The MCP server the gate exposes — connect it to a transport (stdio / Streamable HTTP). */
  /** The gateway re-server (a v2-SDK Server — mcp-query moved to @modelcontextprotocol/server). */
  server: ReturnType<typeof createGateway>;
  /** The underlying mcp-query client fronting the upstreams. */
  client: MCPClient;
  close(): Promise<void>;
}

/** Build (and connect) a gate from config. Connect `gate.server` to a transport to serve. */
export async function createGate(config: GateConfig): Promise<Gate> {
  validateGateConfig(config); // fail loudly on typo'd keys / malformed upstreams before anything connects

  // Order is the onion (outermost first): deny early, protect, then redact the result.
  const interceptors: RequestInterceptor[] = [];
  if (config.policy) interceptors.push(authorize(compilePolicy(config.policy)));
  if (config.circuitBreaker) interceptors.push(circuitBreaker(config.circuitBreaker));
  if (config.rateLimit) interceptors.push(rateLimit(config.rateLimit));
  if (config.redact?.length) interceptors.push(redact(config.redact));

  const client = new MCPClient({
    // Declarative `{command}`/`{url}` specs get their transport factory built here.
    servers: Object.fromEntries(Object.entries(config.upstreams).map(([name, up]) => [name, resolveUpstream(up)])),
    interceptors,
    onCall: config.audit ?? ((e) => console.error(`[gate] ${e.principal ?? "-"} ${e.kind} ${e.server}.${e.target} -> ${e.outcome}`)),
    clientInfo: config.clientInfo ?? { name: "mcp-gate", version: "0.0.1", title: "MCP Gate" },
  });
  await client.connect();

  const server = createGateway(client, {
    namespace: config.namespace ?? true,
    // Hide name-denied tools/prompts from discovery (call-time policy still enforces all rules).
    filter: config.policy ? policyListFilter(config.policy) : undefined,
  });
  return {
    server,
    client,
    close: async () => {
      await server.close().catch(() => {});
      await client.close();
    },
  };
}
