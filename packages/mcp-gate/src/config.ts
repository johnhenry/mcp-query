// Gate configuration. Config is *code* (a .ts/.js module default-exporting a GateConfig),
// but everything — policy AND upstreams — can be expressed declaratively: an upstream is
// either a full ConnectionConfig (transport factory, for full control) or the `.mcp.json`
// shape ({ command } / { url }), for which the gate builds the transport itself so config
// files need no SDK imports.

import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AuthzRequest, AuthzVerdict } from "@johnhenry/mcp-query/server";
import type { ConnectionConfig, ClientInfo, CallAuditEntry } from "@johnhenry/mcp-query";
import type { RedactRule } from "./redact.js";

/** Declarative policy: glob-matched `server.tool` allow/deny lists + a destructive switch. */
export interface GatePolicyRules {
  /** If set, only these (glob) ids are allowed; everything else is denied. */
  allow?: string[];
  /** These (glob) ids are always denied (takes precedence). */
  deny?: string[];
  /** Deny any tool flagged destructiveHint. */
  denyDestructive?: boolean;
}

export type GatePolicy = ((req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict>) | GatePolicyRules;

/** Declarative stdio upstream (the `.mcp.json` shape) — the gate spawns the command. */
export interface StdioUpstreamSpec {
  command: string;
  args?: string[];
  /** Extra environment for the spawned server (merged over the SDK's safe defaults). */
  env?: Record<string, string>;
}

/** Declarative Streamable HTTP upstream (the `.mcp.json` shape). */
export interface HttpUpstreamSpec {
  url: string;
  headers?: Record<string, string>;
  /**
   * Resolve a bearer token fresh before every request to this upstream. Maps directly onto
   * the SDK's own `AuthProvider.token()` — called by the transport itself, per request, with
   * no gate-side caching or shared mutable state, so it's safe under concurrent calls (unlike
   * a naive "mutate a shared headers object" approach, which would race). Mutually exclusive
   * with an `Authorization` entry in `headers`.
   *
   * This resolves a single, possibly-refreshing credential for the upstream connection as a
   * whole — it does not receive per-call context, so it can't differentiate by tenant/caller
   * on its own (neither this SDK generation nor the previous one supports that). For a token
   * that must vary per tenant on the *same* upstream URL, provision one connection per
   * `(upstream, partition)` via `Gate.addUpstream` instead, each with its own `getToken`.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
}

/**
 * An upstream is either a full ConnectionConfig (`transport: () => Transport` factory,
 * plus reconnect tuning) or a declarative spec the gate builds the transport for.
 */
export type GateUpstream = ConnectionConfig | StdioUpstreamSpec | HttpUpstreamSpec;

/** Normalize an upstream to a ConnectionConfig, building the transport factory for declarative specs. */
export function resolveUpstream(upstream: GateUpstream): ConnectionConfig {
  if ("transport" in upstream) return upstream;
  if ("command" in upstream) {
    const { command, args = [], env } = upstream;
    return {
      transport: () =>
        new StdioClientTransport({ command, args, ...(env ? { env: { ...getDefaultEnvironment(), ...env } } : {}) }),
    };
  }
  const { url, headers, getToken } = upstream;
  return {
    transport: () =>
      new StreamableHTTPClientTransport(new URL(url), {
        ...(headers ? { requestInit: { headers } } : {}),
        ...(getToken ? { authProvider: { token: async () => getToken() } } : {}),
      }),
  };
}

export interface GateConfig {
  /** Upstream MCP servers to front (name → transport factory or declarative `{command}`/`{url}` spec). */
  upstreams: Record<string, GateUpstream>;
  policy?: GatePolicy;
  redact?: RedactRule[];
  rateLimit?: { concurrency?: number };
  circuitBreaker?: { threshold?: number; cooldownMs?: number };
  /** Namespace re-exposed tools/prompts as `server.tool`. Default true. */
  namespace?: boolean;
  /**
   * Audit sink for every op (read/call/query), including denials. Default: one line to
   * stderr. The only persistence hook gate has — everything else in gate is in-memory —
   * so a real deployment typically wires this straight into a DB table.
   *
   * Contract (verified against `@johnhenry/mcp-query`'s `MCPClient.run()`):
   * - Fires *after* the operation settles — it's an observability hook, not a veto/blocking
   *   point. It cannot delay, retry, or reject the call; use `policy` for that.
   * - `entry.at` is `Date.now()` at op start; `entry.ms` is wall-clock duration to settle
   *   (`Date.now() - at`), not monotonic — sensitive to system clock adjustments mid-call.
   * - `entry.outcome` is `"ok" | "denied" | "error"`. `"denied"` means specifically an
   *   authorization-policy denial; a rate-limit rejection or an open circuit breaker
   *   (`CircuitOpenError`) is `"error"`, not `"denied"`.
   * - **Not awaited.** mcp-query's `run()` invokes this fire-and-forget; a returned Promise's
   *   settlement is never waited on before the client call resolves (tracked upstream as
   *   johnhenry/mcp-query#22). Gate wraps whatever you pass here so a thrown error or
   *   rejected Promise can't crash the process or produce an unhandled rejection — but the
   *   operation has already completed by the time your callback runs regardless of what it does.
   */
  audit?: (entry: CallAuditEntry) => void;
  clientInfo?: ClientInfo;
  /**
   * Derive a tenant/session partition from request `_meta` for per-tenant `rateLimit`/
   * `circuitBreaker` isolation (so one tenant hammering an upstream doesn't throttle or
   * trip the breaker for every other tenant sharing this gate). Default:
   * `(meta) => meta?.partition as string | undefined`. Runs before `policy`, so a function
   * policy can also branch on `context.partition`. A caller sets this via `_meta.partition`
   * on a raw `tools/call` (the gateway already forwards `_meta` through), or a library-mode
   * embedder sets it directly via `gate.client.scope({ partition, meta })`.
   */
  partitionFrom?: (meta: Record<string, unknown> | undefined) => string | undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
function globToRe(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$");
}

/** Turn a declarative policy (or pass a function through) into an authorize() policy. */
export function compilePolicy(policy: GatePolicy): (req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict> {
  if (typeof policy === "function") return policy;
  const allow = policy.allow?.map(globToRe);
  const deny = policy.deny?.map(globToRe);
  return (req) => {
    const id = `${req.server}.${req.target}`;
    if (deny?.some((re) => re.test(id))) return "deny";
    if (policy.denyDestructive && req.destructive) return "deny";
    if (allow && !allow.some((re) => re.test(id))) return "deny";
    return "allow";
  };
}

/**
 * Derive a gateway list-filter from a *declarative* policy so name-denied tools/prompts
 * are hidden from discovery (not just blocked on call). Returns undefined for a function
 * policy (we can't infer names) — those are still enforced at call time. `denyDestructive`
 * is also call-time only here, since the list-filter doesn't carry tool annotations.
 */
export function policyListFilter(
  policy: GatePolicy,
): ((server: string, kind: "tool" | "resource" | "prompt", name: string) => boolean) | undefined {
  if (typeof policy === "function") return undefined;
  const allow = policy.allow?.map(globToRe);
  const deny = policy.deny?.map(globToRe);
  if (!allow && !deny) return undefined;
  return (server, _kind, name) => {
    const id = `${server}.${name}`;
    if (deny?.some((re) => re.test(id))) return false;
    if (allow && !allow.some((re) => re.test(id))) return false;
    return true;
  };
}
