// Upstream OAuth for HTTP upstreams: machine identity (client credentials) and enterprise-managed
// authorization, so a gate can hold its own identity per upstream instead of a pasted bearer token.
//
//   auth: { type: "client_credentials", ... }   io.modelcontextprotocol/oauth-client-credentials
//   auth: { type: "enterprise", ... }           io.modelcontextprotocol/enterprise-managed-authorization
//
// Secrets are BY REFERENCE only: `{ env: "NAME" }` (read at use time) or `{ get: () => ... }`.
// An inline string is rejected by validateGateConfig. Tokens are cached in memory until shortly
// before they expire, concurrent callers share one in-flight fetch, and neither secrets nor
// tokens ever reach an audit entry or an error message from this module.
//
// ENTERPRISE-MANAGED AUTHORIZATION IS UNTESTED AGAINST A REAL IDENTITY PROVIDER. It is built on
// the SDK's RFC 8693 / RFC 7523 helpers and exercised only against a mock IdP and a mock
// authorization server in this repo's tests. Treat it as experimental until proven against one.

import {
  assertSecureTokenEndpoint,
  discoverOAuthServerInfo,
  exchangeJwtAuthGrant,
  requestJwtAuthorizationGrant,
} from "@modelcontextprotocol/client";
import type { ClientCredentialsAuth, EnterpriseAuth, SecretRef, UpstreamAuth } from "./config.js";

type FetchFn = typeof fetch;

/** Refresh this long before the token's stated expiry. */
const SKEW_MS = 30_000;
/** Lifetime assumed when a token response carries no `expires_in`. */
const DEFAULT_TTL_MS = 60_000;

export interface UpstreamTokenSource {
  /** A valid access token, fetching or refreshing it if the cached one is missing or near expiry. */
  token(): Promise<string>;
  /** Drop the cached token (e.g. after the upstream answered 401) so the next call re-fetches. */
  invalidate(): void;
}

export function isSecretRef(v: unknown): v is SecretRef {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (typeof r.env === "string" && r.env.length > 0 && r.get === undefined) || (typeof r.get === "function" && r.env === undefined);
}

async function resolveSecret(ref: SecretRef, what: string): Promise<string> {
  if ("env" in ref) {
    const v = typeof process !== "undefined" ? process.env[ref.env] : undefined;
    if (!v) throw new Error(`${what}: environment variable ${ref.env} is not set`);
    return v;
  }
  const v = await ref.get();
  if (!v) throw new Error(`${what}: the secret callback returned nothing`);
  return v;
}

/** A single-flight, expiry-aware token cache around `fetchNew`. */
export function cachedTokenSource(
  fetchNew: () => Promise<{ access_token: string; expires_in?: number }>,
  now: () => number = Date.now,
): UpstreamTokenSource {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  let epoch = 0; // bumped by invalidate() so an in-flight fetch started before it is not cached
  return {
    async token() {
      if (cached && now() < cached.expiresAt - SKEW_MS) return cached.token;
      if (inflight) return inflight;
      const mine = epoch;
      const p = (async () => {
        const t = await fetchNew();
        const ttl = typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in * 1000 : DEFAULT_TTL_MS;
        if (mine === epoch) cached = { token: t.access_token, expiresAt: now() + ttl };
        return t.access_token;
      })().finally(() => {
        if (inflight === p) inflight = undefined;
      });
      inflight = p;
      return p;
    },
    invalidate() {
      epoch++;
      cached = undefined;
    },
  };
}

/** Never let a secret or token ride along in an error message. */
function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}

/** Resolve the token endpoint for an authorization server, validating its issuer (RFC 8414 §3.3 / SEP-2352). */
async function resolveEndpoint(
  upstreamUrl: string,
  a: { issuer: string; tokenEndpoint?: string },
  fetchFn: FetchFn,
): Promise<string> {
  if (a.tokenEndpoint) return String(assertSecureTokenEndpoint(a.tokenEndpoint));
  const info = await discoverOAuthServerInfo(upstreamUrl, { fetchFn });
  const meta = info.authorizationServerMetadata;
  if (!meta?.token_endpoint) throw new Error(`no token endpoint discovered for ${upstreamUrl}`);
  const found = meta.issuer ?? info.authorizationServerUrl;
  if (found !== a.issuer) {
    throw new Error(`authorization server issuer mismatch for ${upstreamUrl}: configured "${a.issuer}", discovered "${found}" — refusing to send credentials`);
  }
  return String(assertSecureTokenEndpoint(meta.token_endpoint));
}

/** RFC 6749 §4.4 with client_secret_basic. */
async function clientCredentialsToken(
  url: string,
  a: ClientCredentialsAuth,
  fetchFn: FetchFn,
): Promise<{ access_token: string; expires_in?: number }> {
  const secret = await resolveSecret(a.clientSecret, `upstream auth clientSecret`);
  try {
    const endpoint = await resolveEndpoint(url, a, fetchFn);
    const body = new URLSearchParams({ grant_type: "client_credentials", resource: a.resource ?? url });
    if (a.scope) body.set("scope", a.scope);
    const basic = Buffer.from(`${encodeURIComponent(a.clientId)}:${encodeURIComponent(secret)}`).toString("base64");
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${basic}` },
      body,
    });
    return await readTokenResponse(res, "client_credentials");
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e), [secret]));
  }
}

async function readTokenResponse(res: Response, flow: string): Promise<{ access_token: string; expires_in?: number }> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    // Only the OAuth error code/description: never echo the raw body (it may carry request data).
    const code = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    const desc = typeof json.error_description === "string" ? `: ${json.error_description}` : "";
    throw new Error(`${flow} token request failed (${code}${desc})`);
  }
  if (typeof json.access_token !== "string" || !json.access_token) throw new Error(`${flow} token response had no access_token`);
  return { access_token: json.access_token, expires_in: typeof json.expires_in === "number" ? json.expires_in : undefined };
}

/** Enterprise-managed: IdP token exchange (RFC 8693) -> ID-JAG -> jwt-bearer grant (RFC 7523) at the MCP AS. MOCK-TESTED ONLY. */
async function enterpriseToken(
  url: string,
  a: EnterpriseAuth,
  fetchFn: FetchFn,
): Promise<{ access_token: string; expires_in?: number }> {
  const idToken = await resolveSecret(a.idToken, "upstream auth idToken");
  const idpSecret = a.idp.clientSecret ? await resolveSecret(a.idp.clientSecret, "upstream auth idp.clientSecret") : undefined;
  const asSecret = a.clientSecret ? await resolveSecret(a.clientSecret, "upstream auth clientSecret") : undefined;
  const secrets = [idToken, idpSecret ?? "", asSecret ?? ""];
  try {
    const resource = a.resource ?? url;
    const grant = await requestJwtAuthorizationGrant({
      tokenEndpoint: String(assertSecureTokenEndpoint(a.idp.tokenEndpoint)),
      audience: a.issuer, // the MCP authorization server's issuer identifier
      resource,
      idToken,
      clientId: a.idp.clientId,
      ...(idpSecret ? { clientSecret: idpSecret } : {}),
      ...(a.scope ? { scope: a.scope } : {}),
      fetchFn,
    });
    const endpoint = await resolveEndpoint(url, a, fetchFn);
    const tokens = await exchangeJwtAuthGrant({
      tokenEndpoint: endpoint,
      jwtAuthGrant: grant.jwtAuthGrant,
      clientId: a.clientId,
      ...(asSecret ? { clientSecret: asSecret } : {}),
      authMethod: asSecret ? "client_secret_basic" : "none",
      fetchFn,
    });
    return { access_token: tokens.access_token, expires_in: tokens.expires_in };
  } catch (e) {
    throw new Error(scrub(e instanceof Error ? e.message : String(e), secrets));
  }
}

/** Build the token source for an upstream's `auth` block. */
export function tokenSourceFor(url: string, auth: UpstreamAuth, now?: () => number): UpstreamTokenSource {
  const fetchFn: FetchFn = auth.fetch ?? fetch;
  return cachedTokenSource(
    () => (auth.type === "client_credentials" ? clientCredentialsToken(url, auth, fetchFn) : enterpriseToken(url, auth, fetchFn)),
    now,
  );
}
