// SocialGPT Studio — Deno backend.
//
// Two jobs:
//  1. Reverse-proxy `/mcp` (GET/POST) → https://mcp.gpt.social/mcp, injecting a bearer
//     token read from ~/.mcp-query/oauth/mcp.gpt.social.json. On a 401, refresh the
//     token (POST /oauth/token, grant_type=refresh_token), persist it, and retry once.
//     The upstream may stream text/event-stream, so we forward the body unbuffered and
//     pass through status + headers.
//  2. Serve the built `dist/` assets for every other path (desktop / prod). SPA-style:
//     unknown paths fall back to index.html.
//
// Runs on port 8787. `deno task dev` = `deno run -A backend/main.ts`.

// OAuth 2.1 (DCR + PKCE) helpers — INLINED from oauth.mjs so the compiled `deno desktop`
// binary has no sibling-module import to resolve (deno desktop's macOS relative-module
// resolution is flaky; it choked on "./oauth.mjs"). The Node fallback (node-proxy.mjs)
// still imports the .mjs copy, which stays the single source for that path.
const AUTH_SERVER = "https://mcp.gpt.social";
const RESOURCE = "https://mcp.gpt.social/mcp"; // RFC 8707 resource indicator
const WANT_SCOPES = ["analysis:read", "analysis:read:public", "offline_access"];

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(len = 64): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return base64url(a).slice(0, len);
}
async function discover(): Promise<{ authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; scopes_supported?: string[] }> {
  const res = await fetch(`${AUTH_SERVER}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`oauth discovery failed: ${res.status}`);
  return await res.json();
}
function chooseScope(meta: { scopes_supported?: string[] }): string {
  const supported = new Set(meta?.scopes_supported ?? WANT_SCOPES);
  const picked = WANT_SCOPES.filter((s) => supported.has(s));
  return (picked.length ? picked : ["analysis:read", "offline_access"]).join(" ");
}
async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(digest) };
}
async function register(meta: { registration_endpoint: string }, redirectUri: string, scope: string): Promise<{ client_id: string }> {
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
function buildAuthUrl(
  meta: { authorization_endpoint: string },
  { clientId, redirectUri, scope, challenge, state }: { clientId: string; redirectUri: string; scope: string; challenge: string; state: string },
): string {
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
async function exchangeCode(
  meta: { token_endpoint: string },
  { code, verifier, clientId, redirectUri }: { code: string; verifier: string; clientId: string; redirectUri: string },
): Promise<OAuthFile["tokens"]> {
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, resource: RESOURCE }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return await res.json();
}
function tokenFile({ clientId, redirectUri, verifier, tokens }: { clientId: string; redirectUri: string; verifier: string; tokens: OAuthFile["tokens"] }): OAuthFile {
  return {
    clientInformation: { client_id: clientId, redirect_uris: [redirectUri], token_endpoint_auth_method: "none" },
    tokens,
    codeVerifier: verifier,
  };
}

const UPSTREAM = "https://mcp.gpt.social/mcp";
const TOKEN_ENDPOINT = "https://mcp.gpt.social/oauth/token";
const PORT = 8787;

const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
const TOKEN_DIR = `${HOME}/.mcp-query/oauth`;
const TOKEN_PATH = `${TOKEN_DIR}/mcp.gpt.social.json`;

interface OAuthFile {
  clientInformation: { client_id: string; [k: string]: unknown };
  tokens: {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

async function readOAuth(): Promise<OAuthFile> {
  const text = await Deno.readTextFile(TOKEN_PATH);
  return JSON.parse(text) as OAuthFile;
}

async function writeTokens(file: OAuthFile, tokens: OAuthFile["tokens"]): Promise<void> {
  // Preserve a refresh_token if the refresh response omits it (common with rotating RTs).
  const merged = { ...file.tokens, ...tokens };
  if (!merged.refresh_token && file.tokens.refresh_token) merged.refresh_token = file.tokens.refresh_token;
  const next: OAuthFile = { ...file, tokens: merged };
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(next, null, 2));
}

/** Refresh the access token; persist & return the new file. Throws if there's no RT. */
async function refresh(file: OAuthFile): Promise<OAuthFile> {
  const rt = file.tokens.refresh_token;
  const clientId = file.clientInformation?.client_id;
  if (!rt || !clientId) throw new Error("cannot refresh: missing refresh_token or client_id");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: rt,
    client_id: clientId,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token refresh failed: ${res.status} ${detail}`);
  }
  const tokens = (await res.json()) as OAuthFile["tokens"];
  await writeTokens(file, tokens);
  return { ...file, tokens: { ...file.tokens, ...tokens } };
}

/** Forward one request to the upstream MCP endpoint with the given bearer token. */
async function forward(req: Request, accessToken: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.delete("host");
  headers.delete("content-length");
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.clone().arrayBuffer();
  }
  return await fetch(UPSTREAM, init);
}

/** Handle `/mcp` with refresh-on-401 retry. */
async function handleMcp(req: Request): Promise<Response> {
  let file: OAuthFile;
  try {
    file = await readOAuth();
  } catch (err) {
    return json(500, { error: "no_oauth_token", message: String(err), path: TOKEN_PATH });
  }

  let upstream = await forward(req, file.tokens.access_token);
  if (upstream.status === 401) {
    try {
      file = await refresh(file);
    } catch (err) {
      return json(401, { error: "refresh_failed", message: String(err) });
    }
    upstream = await forward(req, file.tokens.access_token);
  }

  // Pass through status + headers, streaming the body (may be text/event-stream).
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── in-app login (OAuth 2.1: DCR + PKCE, callback on this same port) ──────────
//
// Because this backend, the OAuth callback, and the user's browser are all on the
// same machine in the desktop app, the whole browser-consent flow works with no
// tunnel: /auth/login opens the system browser to the authorize URL; the redirect
// lands back on /auth/callback here; the UI polls /auth/status and proceeds.

interface Pending {
  clientId: string;
  verifier: string;
  state: string;
  redirectUri: string;
  meta: { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
}
let pending: Pending | null = null;

// An ephemeral, *explicit* callback listener started per-login. The packaged `deno desktop`
// build wires the webview↔backend over an internal channel, so the embedded backend may not be
// reachable on an external port by the system browser — but a listener we start ourselves binds
// a normal OS TCP socket the local browser CAN reach at localhost:<port>. We register the OAuth
// redirect_uri against THIS port, then tear it down once the code lands. (Mirrors
// startCallbackServer in packages/mcp-contract/src/oauth.ts.)
let callbackServer: { port: number; close: () => Promise<void> } | null = null;

function startCallbackServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0, // OS-assigned free port; the real one arrives via onListen
        signal: ac.signal,
        onListen: ({ port }) => resolve({ port, close: async () => { ac.abort(); await server.finished.catch(() => {}); } }),
      },
      (req: Request) => {
        const u = new URL(req.url);
        if (u.pathname === "/auth/callback") return authCallback(u);
        return new Response("not found", { status: 404 });
      },
    );
  });
}

async function closeCallbackServer(): Promise<void> {
  if (callbackServer) {
    const cb = callbackServer;
    callbackServer = null;
    await cb.close().catch(() => {});
  }
}

function openBrowser(url: string): void {
  const os = Deno.build.os;
  const [cmd, ...args] = os === "darwin" ? ["open", url] : os === "windows" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    new Deno.Command(cmd, { args, stdout: "null", stderr: "null" }).spawn();
  } catch {
    /* best-effort; the UI also shows a clickable link */
  }
}

function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:34rem;margin:18vh auto;padding:0 1.5rem;text-align:center"><h2>${title}</h2><p style="color:#555">${body}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function authStatus(): Promise<Response> {
  try {
    const f = await readOAuth();
    return json(200, { authenticated: !!f.tokens?.access_token, scope: f.tokens?.scope ?? null });
  } catch {
    return json(200, { authenticated: false, scope: null });
  }
}

async function authLogin(): Promise<Response> {
  try {
    const meta = await discover();
    // Start (or restart) the ephemeral callback listener and register the redirect against its
    // real port, so an external system browser can reach the callback even in the packaged app.
    await closeCallbackServer();
    callbackServer = await startCallbackServer();
    const redirectUri = `http://localhost:${callbackServer.port}/auth/callback`;
    const scope = chooseScope(meta);
    const reg = await register(meta, redirectUri, scope);
    const { verifier, challenge } = await pkce();
    const state = crypto.randomUUID();
    pending = { clientId: reg.client_id, verifier, state, redirectUri, meta };
    const authorizeUrl = buildAuthUrl(meta, { clientId: reg.client_id, redirectUri, scope, challenge, state });
    openBrowser(authorizeUrl);
    return json(200, { authorizeUrl, scope });
  } catch (err) {
    return json(500, { error: "login_init_failed", message: String(err) });
  }
}

/**
 * Validate `state`, exchange `code` for tokens, and persist them. Shared by the GET callback
 * (`authCallback`), the side-server callback, and the paste fallback (`authComplete`).
 */
async function completeLogin(code: string | null, state: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!pending || !code || state !== pending.state) {
    return { ok: false, error: "Invalid or expired login attempt — return to the app and try again." };
  }
  try {
    const tokens = await exchangeCode(pending.meta, { code, verifier: pending.verifier, clientId: pending.clientId, redirectUri: pending.redirectUri });
    await Deno.mkdir(TOKEN_DIR, { recursive: true });
    await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(tokenFile({ clientId: pending.clientId, redirectUri: pending.redirectUri, verifier: pending.verifier, tokens }), null, 2));
    pending = null;
    void closeCallbackServer(); // tear down the ephemeral listener; we're done with it
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function authCallback(url: URL): Promise<Response> {
  const result = await completeLogin(url.searchParams.get("code"), url.searchParams.get("state"));
  return result.ok
    ? htmlPage("✓ Connected", "You're signed in to SocialGPT. Close this tab and return to the app.")
    : htmlPage("Login failed", result.error);
}

/**
 * Paste-the-URL fallback: the user pastes the full `…/auth/callback?code=…&state=…` address their
 * browser landed on (used when the external redirect can't reach the ephemeral listener — e.g. a
 * sandboxed packaged build, or the browser is on another machine). Parses code+state and runs the
 * same exchange as the live callback. Mirrors the stdin paste fallback in mcp-contract's oauth.ts.
 */
async function authComplete(req: Request): Promise<Response> {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, message: "invalid JSON body" });
  }
  const raw = (body.url ?? "").trim();
  if (!raw) return json(400, { ok: false, message: "missing url" });
  let code: string | null = null;
  let state: string | null = null;
  try {
    const u = new URL(raw);
    code = u.searchParams.get("code");
    state = u.searchParams.get("state");
  } catch {
    return json(400, { ok: false, message: "could not parse a URL — paste the full http://localhost…/auth/callback?code=…&state=… address" });
  }
  const result = await completeLogin(code, state);
  return result.ok ? json(200, { ok: true }) : json(400, { ok: false, message: result.error });
}

/**
 * Open an external URL in the system browser. The packaged `deno desktop` webview can't follow
 * `target="_blank"` / `window.open` to the system browser, so the UI POSTs external links here.
 */
async function openExternal(req: Request): Promise<Response> {
  let url: string;
  try {
    url = String(((await req.json()) as { url?: string }).url ?? "").trim();
  } catch {
    return json(400, { ok: false, message: "invalid JSON body" });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return json(400, { ok: false, message: "invalid url" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json(400, { ok: false, message: "only http(s) urls are allowed" });
  }
  openBrowser(parsed.toString());
  return json(200, { ok: true });
}

async function authLogout(): Promise<Response> {
  await closeCallbackServer();
  pending = null;
  try {
    await Deno.remove(TOKEN_PATH);
  } catch {
    /* already gone */
  }
  return json(200, { ok: true });
}

// ── static assets (built dist/) ──────────────────────────────────────────────

const DIST = new URL("../dist/", import.meta.url).pathname;

// The packaged `deno desktop` binary serves the SPA from this embedded map (generated by
// scripts/embed-dist.ts; the static-string import is followed by `deno compile`, so dist
// ships inside the binary — no --include, no runtime fs read). Absent in dev → falls back
// to reading ../dist from disk below.
let DIST_EMBED: Record<string, string> = {};
try {
  DIST_EMBED = ((await import("./dist-embed.json", { with: { type: "json" } })) as { default: Record<string, string> }).default;
} catch {
  /* dev: no embed → serveStatic reads ../dist from disk */
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 ? MIME[path.slice(dot)] : undefined) ?? "application/octet-stream";
}

function embedResponse(key: string): Response {
  return new Response(Uint8Array.from(atob(DIST_EMBED[key]!), (c) => c.charCodeAt(0)), { headers: { "content-type": mimeFor(key) } });
}

async function serveStatic(pathname: string): Promise<Response> {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  // Prevent path traversal.
  const safe = rel.replace(/\.\.+/g, "").replace(/^\/+/, "");

  // 1. Filesystem dist (dev / `deno run`). Preferred so a fresh `npm run build` is always served —
  //    even if a stale backend/dist-embed.json lingers from a `deno task desktop` build. In the
  //    packaged binary there's no dist on disk, so this falls through to the embed below.
  try {
    return new Response(await Deno.readFile(`${DIST}${safe}`), { headers: { "content-type": mimeFor(safe) } });
  } catch {
    /* not on disk → try the embed, then SPA fallback */
  }

  // 2. Embedded SPA (packaged binary).
  if (DIST_EMBED[safe]) return embedResponse(safe);

  // 3. SPA fallback → index.html (filesystem first, then embed).
  try {
    const html = await Deno.readFile(`${DIST}index.html`);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  } catch {
    /* no fs index → embed index */
  }
  if (DIST_EMBED["index.html"]) return embedResponse("index.html");
  return new Response("not found (build the app first: `npm run build`)", { status: 404 });
}

Deno.serve(
  {
    port: PORT,
    onListen: ({ hostname, port }) => console.log(`socialgpt-studio backend listening on http://${hostname}:${port}  (/mcp → ${UPSTREAM})`),
  },
  (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return handleMcp(req);
    if (url.pathname === "/auth/status") return authStatus();
    if (url.pathname === "/auth/login" && req.method === "POST") return authLogin();
    if (url.pathname === "/auth/callback") return authCallback(url); // same-port fallback (shares `pending`)
    if (url.pathname === "/auth/complete" && req.method === "POST") return authComplete(req);
    if (url.pathname === "/auth/logout" && req.method === "POST") return authLogout();
    if (url.pathname === "/open" && req.method === "POST") return openExternal(req);
    return serveStatic(url.pathname);
  },
);
