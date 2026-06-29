// Gate configuration. Config is *code* (a .ts/.js module default-exporting a GateConfig),
// because transports are functions — but the policy can be expressed declaratively.

import type { AuthzRequest, AuthzVerdict } from "../../../src/server/index.js";
import type { ConnectionConfig, ClientInfo, CallAuditEntry } from "../../../src/index.js";
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

export interface GateConfig {
  /** Upstream MCP servers to front (name → transport factory). */
  upstreams: Record<string, ConnectionConfig>;
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
