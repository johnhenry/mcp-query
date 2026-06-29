// SocialGPT Studio — plain-Node reverse proxy (no Deno required).
//
// Mirrors backend/main.ts's `/mcp` handler so the app can be smoke-tested with just
// Node: GET/POST `/mcp` → https://mcp.gpt.social/mcp with a bearer token read from
// ~/.mcp-query/oauth/mcp.gpt.social.json; on a 401 it refreshes the token, persists it,
// and retries once. Streams the upstream body (may be text/event-stream) and forwards
// status + headers. Everything else falls back to serving the built dist/ assets.
//
// Run: `node backend/node-proxy.mjs`  (listens on port 8787).

import http from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { discover, register, pkce, buildAuthUrl, exchangeCode, chooseScope, tokenFile } from "./oauth.mjs";

const UPSTREAM = "https://mcp.gpt.social/mcp";
const TOKEN_ENDPOINT = "https://mcp.gpt.social/oauth/token";
const PORT = 8787;

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
const TOKEN_DIR = join(HOME, ".mcp-query", "oauth");
const TOKEN_PATH = join(TOKEN_DIR, "mcp.gpt.social.json");

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

async function readOAuth() {
  return JSON.parse(await readFile(TOKEN_PATH, "utf8"));
}

async function writeTokens(file, tokens) {
  const merged = { ...file.tokens, ...tokens };
  if (!merged.refresh_token && file.tokens.refresh_token) merged.refresh_token = file.tokens.refresh_token;
  const next = { ...file, tokens: merged };
  await writeFile(TOKEN_PATH, JSON.stringify(next, null, 2));
  return next;
}

async function refresh(file) {
  const rt = file.tokens?.refresh_token;
  const clientId = file.clientInformation?.client_id;
  if (!rt || !clientId) throw new Error("cannot refresh: missing refresh_token or client_id");
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token refresh failed: ${res.status} ${detail}`);
  }
  const tokens = await res.json();
  return await writeTokens(file, tokens);
}

/** Collect a Node request body into a Buffer (undefined for GET/HEAD). */
function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

async function forward(req, bodyBuf, accessToken) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length" || lk === "connection") continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  headers["authorization"] = `Bearer ${accessToken}`;
  const init = { method: req.method, headers, redirect: "manual" };
  if (bodyBuf) init.body = bodyBuf;
  return await fetch(UPSTREAM, init);
}

async function handleMcp(req, res) {
  let file;
  try {
    file = await readOAuth();
  } catch (err) {
    return sendJson(res, 500, { error: "no_oauth_token", message: String(err), path: TOKEN_PATH });
  }

  const bodyBuf = await readBody(req);
  let upstream = await forward(req, bodyBuf, file.tokens.access_token);
  if (upstream.status === 401) {
    try {
      file = await refresh(file);
    } catch (err) {
      return sendJson(res, 401, { error: "refresh_failed", message: String(err) });
    }
    upstream = await forward(req, bodyBuf, file.tokens.access_token);
  }

  const headers = {};
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding") return;
    headers[key] = value;
  });
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// ── in-app login (OAuth 2.1: DCR + PKCE; callback on this same port) ──────────
let pending = null;

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort */
  }
}

function htmlPage(res, title, body) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:34rem;margin:18vh auto;padding:0 1.5rem;text-align:center"><h2>${title}</h2><p style="color:#555">${body}</p></body>`);
}

async function authStatus(res) {
  try {
    const f = await readOAuth();
    sendJson(res, 200, { authenticated: !!f.tokens?.access_token, scope: f.tokens?.scope ?? null });
  } catch {
    sendJson(res, 200, { authenticated: false, scope: null });
  }
}

async function authLogin(res) {
  try {
    const meta = await discover();
    const redirectUri = `http://localhost:${PORT}/auth/callback`;
    const scope = chooseScope(meta);
    const reg = await register(meta, redirectUri, scope);
    const { verifier, challenge } = await pkce();
    const state = randomUUID();
    pending = { clientId: reg.client_id, verifier, state, redirectUri, meta };
    const authorizeUrl = buildAuthUrl(meta, { clientId: reg.client_id, redirectUri, scope, challenge, state });
    openBrowser(authorizeUrl);
    sendJson(res, 200, { authorizeUrl, scope });
  } catch (err) {
    sendJson(res, 500, { error: "login_init_failed", message: String(err) });
  }
}

async function authCallback(url, res) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!pending || !code || state !== pending.state) {
    return htmlPage(res, "Login failed", "Invalid or expired login attempt — return to the app and try again.");
  }
  try {
    const tokens = await exchangeCode(pending.meta, { code, verifier: pending.verifier, clientId: pending.clientId, redirectUri: pending.redirectUri });
    await mkdir(TOKEN_DIR, { recursive: true });
    await writeFile(TOKEN_PATH, JSON.stringify(tokenFile({ clientId: pending.clientId, redirectUri: pending.redirectUri, verifier: pending.verifier, tokens }), null, 2));
    pending = null;
    htmlPage(res, "✓ Connected", "You're signed in to SocialGPT. Close this tab and return to the app.");
  } catch (err) {
    htmlPage(res, "Login failed", String(err));
  }
}

async function authLogout(res) {
  await rm(TOKEN_PATH, { force: true }).catch(() => {});
  sendJson(res, 200, { ok: true });
}

const MIME = {
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

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "").replace(/^[/\\]+/, "");
  const filePath = join(DIST, safe);
  const mime = MIME[extname(filePath)] ?? "application/octet-stream";
  const stream = createReadStream(filePath);
  stream.on("open", () => {
    res.writeHead(200, { "content-type": mime });
    stream.pipe(res);
  });
  stream.on("error", () => {
    // SPA fallback.
    const html = createReadStream(join(DIST, "index.html"));
    html.on("open", () => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      html.pipe(res);
    });
    html.on("error", () => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found (build the app first: `npm run build`)");
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/mcp") {
    handleMcp(req, res).catch((err) => sendJson(res, 502, { error: "proxy_error", message: String(err) }));
    return;
  }
  if (url.pathname === "/auth/status") return void authStatus(res);
  if (url.pathname === "/auth/login" && req.method === "POST") return void authLogin(res);
  if (url.pathname === "/auth/callback") return void authCallback(url, res);
  if (url.pathname === "/auth/logout" && req.method === "POST") return void authLogout(res);
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`socialgpt-studio node proxy listening on http://localhost:${PORT}  (/mcp → ${UPSTREAM})`);
});
