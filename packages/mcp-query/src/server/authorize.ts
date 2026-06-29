// Tool-call / resource authorization — a RequestInterceptor that gates operations by an
// automated policy (the complement to the InteractionBroker's *human* approval). Keys off
// the principal in `context.meta` and the tool's destructive/read-only hints. This finally
// *enforces* destructiveHint (the React layer only surfaces it).

import type { RequestInterceptor, OperationKind } from "../core/interceptors.js";
import type { CallContext } from "../core/client.js";

export type AuthzVerdict = "allow" | "deny";

export interface AuthzRequest {
  kind: OperationKind;
  server: string;
  /** Resource URI (read) or tool name (call/query). */
  target: string;
  args?: Record<string, unknown>;
  context?: CallContext;
  destructive: boolean;
  readOnly: boolean;
}

/** Thrown when a policy denies an operation. Code -32003 → audited as "denied". */
export class AuthorizationError extends Error {
  readonly code = -32003;
  constructor(message = "operation not authorized") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Build an authorization interceptor from a policy. Deny → throws AuthorizationError. */
export function authorize(
  policy: (req: AuthzRequest) => AuthzVerdict | Promise<AuthzVerdict>,
): RequestInterceptor {
  return async (op, next) => {
    const verdict = await policy({
      kind: op.kind,
      server: op.server,
      target: op.target,
      args: op.args,
      context: op.context,
      destructive: op.def?.annotations?.destructiveHint === true,
      readOnly: op.def?.annotations?.readOnlyHint === true,
    });
    if (verdict === "deny") {
      throw new AuthorizationError(`denied: ${op.kind} ${op.server}.${op.target}`);
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
