// Browser-safe gate "library mode" (#65): the governed MCPClient (interceptor stack
// authorize -> approve -> circuit-break -> rate-limit -> redact) with no gateway server and no
// Node-only transport. Everything imported here (mcp-query, mcp-query/server's interceptors, the
// pure policy/redaction modules) loads in a browser bundle. ./index.ts builds the full Node
// `createGate` on the same `buildGateClient`, adding the gateway Server and stdio upstreams.

import { MCPClient, type InteractionBroker, type Operation, type RequestInterceptor, type CallAuditEntry, type ConnectionConfig } from "@johnhenry/mcp-query";
import { authorize, rateLimit, circuitBreaker, type RateLimit, type CircuitBreaker } from "@johnhenry/mcp-query/server";
import { redact } from "./redact.js";
import { compilePolicy, type GateConfig, type GateUpstream } from "./config.js";
import { createApproval } from "./approval.js";
import { resolveHttpUpstream } from "./upstream-http.js";
import { validateGateConfig, validateGateUpstream } from "./validate.js";

/**
 * Per-(server, tenant) keying for rateLimit()/circuitBreaker() — mcp-query's own defaults key
 * by `op.peer` alone (server-only). With no partition ever set (before partitionFrom
 * populates one), every key collapses to `${server}::`, identical across all tenants —
 * so an unconfigured gate behaves exactly like the un-tenant-aware default.
 */
const tenantKey = (op: Operation) => `${op.peer}::${op.context?.partition ?? ""}`;

export interface GateClientParts {
  client: MCPClient;
  approvals?: InteractionBroker;
  /** Drop per-server rateLimit/circuitBreaker state (used when an upstream is removed). */
  dropServer(name: string): void;
}

/** Assemble and connect the governed client. `resolve` turns each upstream into a ConnectionConfig. */
export async function buildGateClient(config: GateConfig, resolve: (u: GateUpstream) => ConnectionConfig): Promise<GateClientParts> {
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
  // Approval is resolved inside authorize()'s own slot (an "approve" verdict calls onApprove),
  // i.e. after allow/deny and before circuit-break/rate-limit/redact: a denied call never
  // reaches a human, and a human wait doesn't hold a rate-limit slot or feed the breaker.
  const approval = config.approval ? createApproval(config.approval) : undefined;
  if (config.policy) interceptors.push(authorize(compilePolicy(config.policy), { onApprove: approval?.onApprove }));
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
    servers: Object.fromEntries(Object.entries(config.upstreams).map(([name, up]) => [name, resolve(up)])),
    interceptors,
    onCall,
    clientInfo: config.clientInfo ?? { name: "mcp-gate", version: "0.4.0", title: "MCP Gate" },
  });
  await client.connect();
  return {
    client,
    approvals: approval?.broker,
    dropServer: (name) => {
      rl?.dropServer(name);
      cb?.dropServer(name);
    },
  };
}

export interface GateClient {
  /** The governed mcp-query client fronting the upstreams. */
  client: MCPClient;
  /** Pending approvals ("approve" verdicts); undefined unless `config.approval` is set. */
  approvals?: InteractionBroker;
  addUpstream(name: string, upstream: GateUpstream): Promise<void>;
  removeUpstream(name: string): Promise<void>;
  updateUpstream(name: string, upstream: GateUpstream): Promise<void>;
  close(): Promise<void>;
}

/**
 * Browser-safe library mode: build and connect a governed client, with no gateway server
 * and no Node-only imports. Upstreams must be a `ConnectionConfig` (any transport factory,
 * e.g. a WebSocket bridge) or an `{ url }` Streamable HTTP spec; a stdio `{ command }` spec
 * throws. In Node, `createGate` from the main entry also gives you `gate.server`.
 */
export async function createGateClient(config: GateConfig): Promise<GateClient> {
  const parts = await buildGateClient(config, resolveHttpUpstream);
  const { client } = parts;
  const addUpstream = async (name: string, upstream: GateUpstream) => {
    validateGateUpstream(name, upstream);
    await client.addServer(name, resolveHttpUpstream(upstream));
  };
  const removeUpstream = async (name: string) => {
    await client.removeServer(name);
    parts.dropServer(name);
  };
  return {
    client,
    approvals: parts.approvals,
    addUpstream,
    removeUpstream,
    updateUpstream: async (name, upstream) => {
      await removeUpstream(name);
      await addUpstream(name, upstream);
    },
    close: () => client.close(),
  };
}
