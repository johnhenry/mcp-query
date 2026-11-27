// Inbound authentication -> call context. A host that fronts the gateway with the SDK's
// `requireBearerAuth` / `verifyBearerToken` (@modelcontextprotocol/server >= 2.0.0) hands the
// verified `AuthInfo` to the handler (`handler.fetch(req, { authInfo })`, surfaced to request
// handlers as `ctx.http.authInfo`). With `inboundAuth` enabled the gateway maps that verified
// principal into the `_meta` it hands the client (`principal`, `partition`, `authScopes`, `authClientId`), so
// policies, `partitionFrom` and audit can use it.
//
// Trust boundary: those three keys are OWNED by the verifier. Whatever the caller put under
// them in its own `_meta` is dropped (an unauthenticated caller must not be able to claim a
// principal), and the access token itself is never copied anywhere.

import { AuthorizationError } from "./authorize.js";

/** The slice of the SDK's `AuthInfo` this mapping reads. */
export interface InboundAuthInfo {
  clientId?: string;
  scopes?: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

export interface InboundAuthOptions {
  /** Reject calls that arrive without a verified `AuthInfo` (default false: they proceed unauthenticated, with no principal). */
  required?: boolean;
  /** Derive the principal. Default: `extra.sub` when a string, else `clientId`. */
  principal?: (auth: InboundAuthInfo) => string | undefined;
  /** Derive the partition (tenant isolation key for caches, task ids, rate limits). Default: the principal. */
  partition?: (auth: InboundAuthInfo) => string | undefined;
}

/** `_meta` keys the verifier owns. */
export const INBOUND_AUTH_META_KEYS = ["principal", "partition", "authScopes", "authClientId"] as const;

const defaultPrincipal = (a: InboundAuthInfo): string | undefined => (typeof a.extra?.sub === "string" ? a.extra.sub : a.clientId);

/**
 * Build the `_meta` for a call: the caller's own keys, minus the verifier-owned ones, plus the
 * verified principal when there is one. Returns the caller's meta untouched when `inboundAuth`
 * is off. Throws {@link AuthorizationError} when `required` and nothing was verified.
 */
export function applyInboundAuth(
  callerMeta: Record<string, unknown> | undefined,
  auth: InboundAuthInfo | undefined,
  opts: boolean | InboundAuthOptions | undefined,
): Record<string, unknown> | undefined {
  if (!opts) return callerMeta;
  const o: InboundAuthOptions = opts === true ? {} : opts;
  if (!auth && o.required) throw new AuthorizationError("denied: this gateway requires a verified bearer token (inbound auth)");
  const rest: Record<string, unknown> = { ...(callerMeta ?? {}) };
  for (const k of INBOUND_AUTH_META_KEYS) delete rest[k];
  if (!auth) return Object.keys(rest).length || callerMeta ? rest : undefined;
  const principal = (o.principal ?? defaultPrincipal)(auth);
  const partition = (o.partition ?? ((a: InboundAuthInfo) => (o.principal ?? defaultPrincipal)(a)))(auth);
  return {
    ...rest,
    ...(principal !== undefined ? { principal } : {}),
    ...(partition !== undefined ? { partition } : {}),
    authScopes: [...(auth.scopes ?? [])],
    ...(auth.clientId !== undefined ? { authClientId: auth.clientId } : {}),
  };
}
