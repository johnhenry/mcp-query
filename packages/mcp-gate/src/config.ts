// Gate configuration. Config is *code* (a .ts/.js module default-exporting a GateConfig),
// but everything — policy AND upstreams — can be expressed declaratively: an upstream is
// either a full ConnectionConfig (transport factory, for full control) or the `.mcp.json`
// shape ({ command } / { url }), for which the gate builds the transport itself so config
// files need no SDK imports.

import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthzRequest, AuthzVerdict } from "../../mcp-query/src/server/index.js";
import type { ConnectionConfig, ClientInfo, CallAuditEntry } from "../../mcp-query/src/index.js";
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
  const { url, headers } = upstream;
  return {
    transport: () => new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined),
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
  /** Audit sink for every op. Default: one line to stderr. */
  audit?: (entry: CallAuditEntry) => void;
  clientInfo?: ClientInfo;
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
