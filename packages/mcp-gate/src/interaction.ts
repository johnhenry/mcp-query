// Forwarded-interaction policy (#82). When the gate forwards an upstream's `input_required`
// (MRTR) round to its consumer, a URL-mode elicitation sends a person to a URL the upstream
// chose. This interceptor decides, per host, whether that round may reach the consumer.
// Pure and browser-safe (no Node imports).

import { AuthorizationError } from "@johnhenry/mcp-query/server";
import { isInputRequiredResult, urlHost, type CallAuditEntry, type RequestInterceptor } from "@johnhenry/mcp-query";
import type { AnswerGuard, AnswerGuardResult, AuthzRequest, AuthzVerdict, GatewayInteractions } from "@johnhenry/mcp-query/server";
import { redactTracked, type RedactRule } from "./redact.js";
import type { AnswerPolicy } from "./config.js";

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
    // An MRTR `input_required` round, or a task waiting for input (tasks extension): same requests, same rule.
    const waiting = isInputRequiredResult(result) || (op.kind === "task" && (result as { status?: unknown } | null)?.status === "input_required");
    if (!waiting) return result;
    const requests = (result as { inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }> }).inputRequests;
    for (const [key, req] of Object.entries(requests ?? {})) {
      if (req.method !== "elicitation/create" || req.params?.mode !== "url") continue;
      const verdict = check(urlHost(req.params.url));
      if (!verdict.ok) throw new AuthorizationError(`denied: url elicitation "${key}" from ${op.peer}.${op.target}: ${verdict.reason}`);
    }
    return result;
  };
}

// ── The answer hop (#100) ───────────────────────────────────────────────────────────────────
// The consumer's retry carries `inputResponses`: what a person typed into a forwarded form.
// That is user-entered data leaving through the gate, so it gets the same DLP as results do.

const globRe = (glob: string) => new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$");

/** Field names an answer's `content` carries, as dotted paths (`address.zip`); arrays are one field. */
function fieldPaths(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    return entries.length ? entries.flatMap(([k, v]) => fieldPaths(v, prefix ? `${prefix}.${k}` : k)) : prefix ? [prefix] : [];
  }
  return prefix ? [prefix] : [];
}

/** Compile an `AnswerPolicy` to a verdict function. Undefined policy: allow. */
export function compileAnswerPolicy(policy: AnswerPolicy | undefined, server: string): (req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict> {
  if (policy === undefined) return () => "allow";
  if (typeof policy === "function") return policy;
  const deny = policy.deny?.map(globRe);
  const approve = policy.approve?.map(globRe);
  const denyFields = policy.denyFields?.map(globRe);
  const approveFields = policy.approveFields?.map(globRe);
  const fieldHit = (res: RegExp[] | undefined, fields: string[]) => !!res?.length && fields.some((f) => res.some((re) => re.test(f) || re.test(f.slice(f.lastIndexOf(".") + 1))));
  return (req) => {
    const id = `${server}.${req.target}`;
    const fields = req.answer?.fields ?? [];
    if (deny?.some((re) => re.test(id))) return "deny";
    if (fieldHit(denyFields, fields)) return "deny";
    if (approve?.some((re) => re.test(id))) return "approve";
    if (fieldHit(approveFields, fields)) return "approve";
    return "allow";
  };
}

export interface AnswerGuardOptions {
  /** The gate's `redact` rules, applied to every answer. */
  redact?: RedactRule[];
  /** The gate's `answerPolicy`. */
  policy?: AnswerPolicy;
  /** Resolves an "approve" verdict (the gate's approval backend); absent: "approve" fails closed as a deny. */
  onApprove?: (req: AuthzRequest) => void | Promise<void>;
  /** Audit sink for a refusal that never reaches the upstream call (so is not audited by the client). */
  audit?: (entry: CallAuditEntry) => void;
  /** Tool annotations for the policy's `destructive` / `readOnly`. */
  toolHints?: (server: string, tool: string) => { destructive: boolean; readOnly: boolean };
}

const DECLINE = { action: "decline" } as const;

/**
 * Build the gateway's `guardAnswers` hook: for each `accept`ed answer, ask the answer policy
 * (allow / deny / approve); a denied one becomes `{ action: "decline" }`. Then run the `redact`
 * rules over what is left. Reports which fields were redacted and which keys were declined.
 * An answer that is not an elicitation result (no string `action`) cannot be declined, so a
 * denial of one refuses the retry (-32003) instead.
 */
export function createAnswerGuard(opts: AnswerGuardOptions): AnswerGuard {
  return async (req): Promise<AnswerGuardResult> => {
    const verdictOf = compileAnswerPolicy(opts.policy, req.server);
    const hints = req.kind !== "prompt" ? opts.toolHints?.(req.server, req.target) : undefined;
    const out: Record<string, unknown> = {};
    const declined: string[] = [];
    const redactedFields: string[] = [];
    for (const [key, answer] of Object.entries(req.inputResponses)) {
      const shaped = answer && typeof answer === "object" && typeof (answer as { action?: unknown }).action === "string";
      const action = shaped ? (answer as { action: string }).action : "";
      let current: unknown = answer;
      // Only an accepted answer carries data; decline/cancel have nothing to leak or to judge.
      if (!shaped || action === "accept") {
        const authz: AuthzRequest = {
          kind: "answer",
          server: req.server,
          target: req.target,
          args: req.args,
          context: req.context as AuthzRequest["context"],
          destructive: hints?.destructive ?? false,
          readOnly: hints?.readOnly ?? false,
          answer: { surface: req.kind, key, action: shaped ? action : "(unrecognised)", fields: fieldPaths((answer as { content?: unknown } | null)?.content) },
        };
        let verdict = await verdictOf(authz);
        let why = `answer "${key}" to ${req.server}.${req.target} denied by policy`;
        if (verdict === "approve") {
          if (!opts.onApprove) {
            verdict = "deny";
            why = `answer "${key}" to ${req.server}.${req.target} requires approval but no approver is configured`;
          } else {
            try {
              await opts.onApprove(authz);
              verdict = "allow";
            } catch (e) {
              if (!(e instanceof AuthorizationError)) throw e;
              verdict = "deny";
              why = `answer "${key}" to ${req.server}.${req.target} not approved: ${e.message}`;
            }
          }
        }
        if (verdict === "deny") {
          if (!shaped) {
            const err = new AuthorizationError(`denied: ${why}; it is not an elicitation result, so it cannot be declined`);
            opts.audit?.({
              at: Date.now(), ms: 0, server: req.server, kind: "call", target: req.target,
              principal: (req.context?.meta as { principal?: unknown } | undefined)?.principal,
              outcome: "denied", error: err.message, interaction: { phase: "response", declined: [key] },
            });
            throw err;
          }
          out[key] = { ...DECLINE };
          declined.push(key);
          continue;
        }
      }
      // Every surviving answer is scrubbed, whatever its action (a decline has no business carrying content).
      if (opts.redact?.length) {
        const r = redactTracked(opts.redact, current);
        current = r.value;
        redactedFields.push(...r.paths.map((p) => (p ? `${key}.${p}` : key)));
      }
      out[key] = current;
    }
    return { inputResponses: out, redactedFields, declined };
  };
}
