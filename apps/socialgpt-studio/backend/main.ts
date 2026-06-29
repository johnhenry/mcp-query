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

import { discover, register, pkce, buildAuthUrl, exchangeCode, chooseScope, tokenFile } from "./oauth.mjs";

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
    const redirectUri = `http://localhost:${PORT}/auth/callback`;
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

async function authCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!pending || !code || state !== pending.state) {
    return htmlPage("Login failed", "Invalid or expired login attempt — return to the app and try again.");
  }
  try {
    const tokens = await exchangeCode(pending.meta, { code, verifier: pending.verifier, clientId: pending.clientId, redirectUri: pending.redirectUri });
    await Deno.mkdir(TOKEN_DIR, { recursive: true });
    await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(tokenFile({ clientId: pending.clientId, redirectUri: pending.redirectUri, verifier: pending.verifier, tokens }), null, 2));
    pending = null;
    return htmlPage("✓ Connected", "You're signed in to SocialGPT. Close this tab and return to the app.");
  } catch (err) {
    return htmlPage("Login failed", String(err));
  }
}

async function authLogout(): Promise<Response> {
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

async function serveStatic(pathname: string): Promise<Response> {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  // Prevent path traversal.
  const safe = rel.replace(/\.\.+/g, "").replace(/^\/+/, "");

  // 1. Embedded SPA (packaged binary). SPA fallback → index.html for unknown routes.
  if (Object.keys(DIST_EMBED).length) {
    const hit = DIST_EMBED[safe] ? safe : DIST_EMBED["index.html"] ? "index.html" : undefined;
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(Uint8Array.from(atob(DIST_EMBED[hit]!), (c) => c.charCodeAt(0)), { headers: { "content-type": mimeFor(hit) } });
  }

  // 2. Filesystem dist (dev / `deno run -A backend/main.ts`).
  const filePath = `${DIST}${safe}`;
  try {
    const data = await Deno.readFile(filePath);
    return new Response(data, { headers: { "content-type": mimeFor(filePath) } });
  } catch {
    // SPA fallback.
    try {
      const html = await Deno.readFile(`${DIST}index.html`);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch {
      return new Response("not found (build the app first: `npm run build`)", { status: 404 });
    }
  }
}

Deno.serve({ port: PORT }, (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/mcp") return handleMcp(req);
  if (url.pathname === "/auth/status") return authStatus();
  if (url.pathname === "/auth/login" && req.method === "POST") return authLogin();
  if (url.pathname === "/auth/callback") return authCallback(url);
  if (url.pathname === "/auth/logout" && req.method === "POST") return authLogout();
  return serveStatic(url.pathname);
});

console.log(`socialgpt-studio backend listening on http://localhost:${PORT}  (/mcp → ${UPSTREAM})`);
