// Portable OAuth 2.1 (DCR + PKCE) helpers for the SocialGPT backend. Uses only
// web-standard APIs (fetch, crypto.subtle, crypto.getRandomValues, TextEncoder, btoa)
// so it runs unchanged under both Deno and Node 18+. File IO and browser-open are the
// caller's job (they differ per runtime). The desktop backend hosts the redirect_uri
// on its OWN port, so the OAuth callback is just a route — no separate server, no tunnel.

const AUTH_SERVER = "https://mcp.gpt.social";
const RESOURCE = "https://mcp.gpt.social/mcp"; // RFC 8707 resource indicator
const WANT_SCOPES = ["analysis:read", "analysis:read:public", "offline_access"];

function base64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len = 64) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a).slice(0, len);
}

/** Discover the authorization server's endpoints + supported scopes. */
export async function discover() {
  const res = await fetch(`${AUTH_SERVER}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`oauth discovery failed: ${res.status}`);
  return await res.json();
}

/** Pick the widest of the scopes we want that the server supports. */
export function chooseScope(meta) {
  const supported = new Set(meta?.scopes_supported ?? WANT_SCOPES);
  const picked = WANT_SCOPES.filter((s) => supported.has(s));
  return (picked.length ? picked : ["analysis:read", "offline_access"]).join(" ");
}

/** Generate a PKCE verifier + S256 challenge. */
export async function pkce() {
  const verifier = randomString(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}

/** Dynamic client registration. Returns the registered client (incl. client_id). */
export async function register(meta, redirectUri, scope) {
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "SocialGPT Studio",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  if (!res.ok) throw new Error(`client registration failed: ${res.status} ${await res.text().catch(() => "")}`);
  return await res.json();
}

/** Build the authorize URL the user opens to log in + consent. */
export function buildAuthUrl(meta, { clientId, redirectUri, scope, challenge, state }) {
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  return u.toString();
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(meta, { code, verifier, clientId, redirectUri }) {
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: RESOURCE,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return await res.json();
}

/** Build the on-disk cache file (shape compatible with mcp-contract + the /mcp proxy). */
export function tokenFile({ clientId, redirectUri, verifier, tokens }) {
  return {
    clientInformation: { client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" },
    tokens,
    codeVerifier: verifier,
  };
}
