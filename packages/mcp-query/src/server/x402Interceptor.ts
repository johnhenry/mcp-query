// x402 pay-and-retry interceptor — request -> 402 challenge -> gate -> retry once.
// Verification/simulation only: never signs or moves money, never attaches a real
// payment proof, no key custody. `context.meta` (JSON-RPC data) can't produce an
// `X-PAYMENT` HTTP header on a retry regardless of design, since the transport's
// fetchFn is pinned at connection setup, not per-Operation — real settlement would
// need a Middleware-level (raw-fetch, withOAuth-style) piece, deliberately not built
// here. This interceptor exists to route challenges through gate()/audit/policy with
// real tool/resource identity, safely, before any settlement integration exists.
//
// Detects the 402 via MCPClient's own `MCPError`, not the SDK's raw `SdkHttpError`:
// `execCall` (the innermost exec this interceptor's `next()` reaches) already wraps
// every SDK error into an `MCPError` — with `kind: "transport"` and
// `data: {sdkCode, status, cause}` for an SdkHttpError — before it propagates back
// through the interceptor chain, so a raw `SdkHttpError` never reaches here.

import type { Operation, RequestInterceptor } from "../core/interceptors.js";
import { MCPError } from "../core/types.js";
import { parseX402Challenge, type X402Challenge } from "./x402.js";

interface HttpErrorData {
  status?: number;
  cause?: { text?: string };
}

function as402Body(err: unknown): string | undefined {
  if (!(err instanceof MCPError) || err.kind !== "transport") return undefined;
  const data = err.data as HttpErrorData | undefined;
  if (data?.status !== 402) return undefined;
  return data.cause?.text;
}

export type X402GateVerdict = "pay" | "deny";

export interface X402InterceptorOptions {
  /** Explicit opt-in — required, no implicit default-on even if `gate` is set. */
  enabled: boolean;
  /**
   * Consulted once per 402 with the parsed challenge + the operation. "pay" never
   * attaches a real payment proof — it retries the bare op once so gate()/audit/policy
   * wiring can be exercised end-to-end before real settlement exists. Omit (or return
   * "deny") to always surface X402ChallengeError — the safe default.
   */
  gate?: (challenge: X402Challenge, op: Operation) => X402GateVerdict | Promise<X402GateVerdict>;
}

/** Thrown on an unresolved (or denied) x402 challenge. Code -32005 → audited as "error". */
export class X402ChallengeError extends Error {
  readonly code = -32005;
  constructor(
    readonly challenge: X402Challenge,
    readonly op: Pick<Operation, "kind" | "server" | "target">,
    readonly nonIdempotent = false,
  ) {
    super(
      nonIdempotent
        ? `x402 payment required for ${op.kind} ${op.server}.${op.target} — not retried (non-idempotent)`
        : `x402 payment required for ${op.kind} ${op.server}.${op.target}`,
    );
    this.name = "X402ChallengeError";
  }
}

const isIdempotent = (op: Operation): boolean => op.kind === "read" || op.def?.annotations?.readOnlyHint === true;

export function x402Interceptor(opts: X402InterceptorOptions): RequestInterceptor {
  return async (op, next) => {
    if (!opts.enabled) return next(op);
    try {
      return await next(op);
    } catch (err) {
      const body = as402Body(err);
      if (body === undefined) throw err;
      const challenge = parseX402Challenge(body);
      if (!challenge) throw err;

      const verdict = opts.gate ? await opts.gate(challenge, op) : "deny";
      if (verdict !== "pay") throw new X402ChallengeError(challenge, op);
      if (!isIdempotent(op)) throw new X402ChallengeError(challenge, op, true);
      if (op.state.x402Retried) throw new X402ChallengeError(challenge, op);

      op.state.x402Retried = true;
      try {
        return await next(op);
      } catch (retryErr) {
        const retryBody = as402Body(retryErr);
        if (retryBody !== undefined) {
          const retryChallenge = parseX402Challenge(retryBody) ?? challenge;
          throw new X402ChallengeError(retryChallenge, op);
        }
        throw retryErr;
      }
    }
  };
}
