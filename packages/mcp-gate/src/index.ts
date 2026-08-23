// mcp-gate — a config-driven MCP security/policy proxy. Assembles an mcp-query MCPClient
// (with an interceptor stack: authorize → circuit-break → rate-limit → redact) behind a
// gateway Server, so an agent sees ONE governed MCP endpoint fronting many upstreams.

import { MCPClient, type Operation, type RequestInterceptor, type CallAuditEntry } from "@johnhenry/mcp-query";
import { authorize, createGateway, rateLimit, circuitBreaker, type RateLimit, type CircuitBreaker } from "@johnhenry/mcp-query/server";
import { redact } from "./redact.js";
import { compilePolicy, policyListFilter, resolveUpstream, type GateConfig, type GateUpstream } from "./config.js";
import { validateGateConfig, validateGateUpstream } from "./validate.js";

export type { GateConfig, GatePolicy, GatePolicyRules, GateUpstream, StdioUpstreamSpec, HttpUpstreamSpec } from "./config.js";
export type { RedactRule } from "./redact.js";
export { redact } from "./redact.js";
export { compilePolicy, policyListFilter, resolveUpstream } from "./config.js";
export { validateGateConfig } from "./validate.js";
export { CircuitOpenError } from "@johnhenry/mcp-query/server";

/**
 * Per-(server, tenant) keying for rateLimit()/circuitBreaker() — mcp-query's own defaults key
 * by `op.peer` alone (server-only). With no partition ever set (before partitionFrom
 * populates one), every key collapses to `${server}::`, identical across all tenants —
 * so an unconfigured gate behaves exactly like the un-tenant-aware default.
 */
const tenantKey = (op: Operation) => `${op.peer}::${op.context?.partition ?? ""}`;

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
  close(): Promise<void>;
}

/** Build (and connect) a gate from config. Connect `gate.server` to a transport to serve. */
export async function createGate(config: GateConfig): Promise<Gate> {
  validateGateConfig(config); // fail loudly on typo'd keys / malformed upstreams before anything connects

  const partitionFrom = config.partitionFrom ?? ((meta: Record<string, unknown> | undefined) => meta?.partition as string | undefined);
  const populatePartition: RequestInterceptor = (op, next) => {
    if (op.context?.partition === undefined) {
      const p = partitionFrom(op.context?.meta as Record<string, unknown> | undefined);
      if (p !== undefined) op.context = { ...op.context, partition: p };
    }
    return next(op);
  };

  // Order is the onion (outermost first): resolve tenant, deny early, protect, then redact the result.
  const interceptors: RequestInterceptor[] = [populatePartition];
  if (config.policy) interceptors.push(authorize(compilePolicy(config.policy)));
  const cb: CircuitBreaker | undefined = config.circuitBreaker ? circuitBreaker({ ...config.circuitBreaker, keyFn: tenantKey }) : undefined;
  if (cb) interceptors.push(cb.interceptor);
  const rl: RateLimit | undefined = config.rateLimit ? rateLimit({ ...config.rateLimit, keyFn: tenantKey }) : undefined;
  if (rl) interceptors.push(rl.interceptor);
  if (config.redact?.length) interceptors.push(redact(config.redact));

  const rawAudit: (entry: CallAuditEntry) => unknown =
    config.audit ?? ((e) => console.error(`[gate] ${e.principal ?? "-"} ${e.kind} ${e.server}.${e.target} -> ${e.outcome}`));
  // mcp-query calls onCall fire-and-forget (not awaited — see the "audit" TSDoc on GateConfig for
  // the full contract); this wrapper only adds crash-safety, catching a sync throw or an
  // async rejection so a broken audit sink can't take down the process or produce an
  // unhandled rejection. It cannot make the operation wait on audit completion.
  const onCall = (entry: CallAuditEntry) => {
    try {
      const r = rawAudit(entry);
      if (r && typeof (r as PromiseLike<unknown>).then === "function") {
        Promise.resolve(r).catch((e) => console.error("[gate] audit callback rejected:", e));
      }
    } catch (e) {
      console.error("[gate] audit callback threw:", e);
    }
  };

  const client = new MCPClient({
    // Declarative `{command}`/`{url}` specs get their transport factory built here.
    servers: Object.fromEntries(Object.entries(config.upstreams).map(([name, up]) => [name, resolveUpstream(up)])),
    interceptors,
    onCall,
    clientInfo: config.clientInfo ?? { name: "mcp-gate", version: "0.1.0", title: "MCP Gate" },
  });
  await client.connect();

  const server = createGateway(client, {
    namespace: config.namespace ?? true,
    // Hide name-denied tools/prompts from discovery (call-time policy still enforces all rules).
    filter: config.policy ? policyListFilter(config.policy) : undefined,
  });

  const addUpstream = async (name: string, upstream: GateUpstream) => {
    validateGateUpstream(name, upstream);
    await client.addServer(name, resolveUpstream(upstream));
    // tools/resources/prompts list_changed already fires: addServer shares the same
    // capability-listener wiring an eager-connected server gets at construction time.
  };
  const removeUpstream = async (name: string) => {
    await client.removeServer(name); // no-op if `name` doesn't exist
    rl?.dropServer(name);
    cb?.dropServer(name);
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
    close: async () => {
      await server.close().catch(() => {});
      await client.close();
    },
  };
}
