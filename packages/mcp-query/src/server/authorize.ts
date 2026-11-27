// Tool-call / resource authorization — a RequestInterceptor that gates operations by an
// automated policy (the complement to the InteractionBroker's *human* approval). Keys off
// the principal in `context.meta` and the tool's destructive/read-only hints. This finally
// *enforces* destructiveHint (the React layer only surfaces it).

import type { RequestInterceptor, OperationKind, Operation } from "../core/interceptors.js";
import type { CallContext } from "../core/client.js";

/**
 * "allow" proceeds, "deny" throws, "approve" means "allowed only if a human (or other
 * approver) says so" — resolved by `authorize(policy, { onApprove })`. Without an
 * `onApprove` an "approve" verdict is treated as a deny (fail closed).
 */
export type AuthzVerdict = "allow" | "deny" | "approve";

export interface AuthzRequest {
  /**
   * `"answer"` is the answer hop of a forwarded MRTR round (mcp-gate `answerPolicy`): the
   * consumer's reply to ONE upstream input request, judged before it goes upstream. `authorize()`
   * itself only ever produces the operation kinds.
   */
  kind: OperationKind | "answer";
  server: string;
  /** Resource URI (read) or tool name (call/query). */
  target: string;
  args?: Record<string, unknown>;
  context?: CallContext;
  destructive: boolean;
  readOnly: boolean;
  /** `kind: "answer"` only: what the consumer answered. Field names only, never values. */
  answer?: AnswerInfo;
}

/** One consumer answer to one upstream input request, as a policy sees it (no values). */
export interface AnswerInfo {
  /** Whether the round belongs to a `tools/call` or a `prompts/get`. */
  surface: "tool" | "prompt";
  /** The input request's key in the round (`q0`, ...). */
  key: string;
  /** The elicitation action the consumer chose. Only `accept` carries data, so only `accept` is judged. */
  action: string;
  /** Names (dotted paths) of the fields the consumer filled in. */
  fields: string[];
}

/** Thrown when a policy denies an operation. Code -32003 → audited as "denied". */
export class AuthorizationError extends Error {
  readonly code = -32003;
  constructor(message = "operation not authorized") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface AuthorizeOptions {
  /**
   * Called when the policy returns "approve". Resolve to let the operation proceed; throw
   * (e.g. an AuthorizationError) to refuse it. Omitted ⇒ "approve" fails closed as a deny.
   */
  onApprove?: (req: AuthzRequest, op: Operation) => void | Promise<void>;
}

/** Build an authorization interceptor from a policy. Deny → throws AuthorizationError. */
export function authorize(
  policy: (req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict>,
  opts: AuthorizeOptions = {},
): RequestInterceptor {
  return async (op, next) => {
    const req: AuthzRequest = {
      kind: op.kind,
      server: op.peer,
      target: op.target,
      args: op.args,
      context: op.context,
      destructive: op.def?.annotations?.destructiveHint === true,
      readOnly: op.def?.annotations?.readOnlyHint === true,
    };
    const verdict = await policy(req);
    if (verdict === "deny") {
      throw new AuthorizationError(`denied: ${op.kind} ${op.peer}.${op.target}`);
    }
    if (verdict === "approve") {
      if (!opts.onApprove) {
        throw new AuthorizationError(`denied: ${op.kind} ${op.peer}.${op.target} requires approval but no approver is configured`);
      }
      await opts.onApprove(req, op);
    }
    return next(op);
  };
}

/** Convenience policy: deny destructive tools unless `allow(req)` returns true. */
export function denyDestructiveUnless(
  allow: (req: AuthzRequest) => boolean | Promise<boolean>,
): (req: AuthzRequest) => Promise<AuthzVerdict> {
  return async (req) => (!req.destructive || (await allow(req)) ? "allow" : "deny");
}
