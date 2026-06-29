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
import { readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";
import os from "node:os";

const UPSTREAM = "https://mcp.gpt.social/mcp";
const TOKEN_ENDPOINT = "https://mcp.gpt.social/oauth/token";
const PORT = 8787;

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
const TOKEN_PATH = join(HOME, ".mcp-query", "oauth", "mcp.gpt.social.json");

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
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`socialgpt-studio node proxy listening on http://localhost:${PORT}  (/mcp → ${UPSTREAM})`);
});
