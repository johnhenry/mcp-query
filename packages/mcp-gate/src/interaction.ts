// Forwarded-interaction policy (#82). When the gate forwards an upstream's `input_required`
// (MRTR) round to its consumer, a URL-mode elicitation sends a person to a URL the upstream
// chose. This interceptor decides, per host, whether that round may reach the consumer.
// Pure and browser-safe (no Node imports).

import { AuthorizationError } from "@johnhenry/mcp-query/server";
import { isInputRequiredResult, urlHost, type RequestInterceptor } from "@johnhenry/mcp-query";
import type { GatewayInteractions } from "@johnhenry/mcp-query/server";

/**
 * Which hosts a forwarded URL-mode elicitation may send the consumer to. Globs match the
 * lowercased hostname (`*` matches any run of characters, so `*.example.com` also matches
 * `a.b.example.com` but not `example.com`). Precedence: `denyHosts`, then `allowHosts`.
 * Without `allowHosts`, nothing is allowed: URL elicitation fails closed.
 */
export interface UrlElicitationPolicy {
  allowHosts?: string[];
  denyHosts?: string[];
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const hostGlob = (glob: string) => new RegExp("^" + glob.toLowerCase().split("*").map(escapeRe).join(".*") + "$");

/** Compile a policy to a host check. Returns the verdict and (when denied) why. */
export function compileUrlPolicy(policy: UrlElicitationPolicy | undefined): (host: string | undefined) => { ok: true } | { ok: false; reason: string } {
  const allow = policy?.allowHosts?.map(hostGlob);
  const deny = policy?.denyHosts?.map(hostGlob);
  return (host) => {
    if (host === undefined) return { ok: false, reason: "url does not parse to a host" };
    if (deny?.some((re) => re.test(host))) return { ok: false, reason: `host "${host}" is denied` };
    if (!allow?.length) return { ok: false, reason: `host "${host}" is not allowed (no urlElicitation.allowHosts configured)` };
    if (!allow.some((re) => re.test(host))) return { ok: false, reason: `host "${host}" is not in urlElicitation.allowHosts` };
    return { ok: true };
  };
}

/** True when any upstream may forward interactions. */
export function forwardsAnything(interactions: GatewayInteractions | undefined): boolean {
  if (interactions === undefined) return false;
  if (typeof interactions === "string") return interactions === "forward";
  return interactions.default === "forward" || Object.values(interactions.upstreams ?? {}).includes("forward");
}

/**
 * Interceptor: refuse (AuthorizationError, -32003, audited "denied") an `input_required`
 * result carrying a URL-mode elicitation whose host the policy rejects. Place it OUTSIDE the
 * redact interceptor so it judges the URL the consumer would actually be sent to.
 */
export function urlElicitationPolicy(policy: UrlElicitationPolicy | undefined): RequestInterceptor {
  const check = compileUrlPolicy(policy);
  return async (op, next) => {
    const result = await next(op);
    if (!isInputRequiredResult(result)) return result;
    for (const [key, req] of Object.entries(result.inputRequests ?? {})) {
      if (req.method !== "elicitation/create" || req.params?.mode !== "url") continue;
      const verdict = check(urlHost(req.params.url));
      if (!verdict.ok) throw new AuthorizationError(`denied: url elicitation "${key}" from ${op.peer}.${op.target}: ${verdict.reason}`);
    }
    return result;
  };
}
