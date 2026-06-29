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

const UPSTREAM = "https://mcp.gpt.social/mcp";
const TOKEN_ENDPOINT = "https://mcp.gpt.social/oauth/token";
const PORT = 8787;

const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
const TOKEN_PATH = `${HOME}/.mcp-query/oauth/mcp.gpt.social.json`;

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

// ── static assets (built dist/) ──────────────────────────────────────────────

const DIST = new URL("../dist/", import.meta.url).pathname;

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
  return serveStatic(url.pathname);
});

console.log(`socialgpt-studio backend listening on http://localhost:${PORT}  (/mcp → ${UPSTREAM})`);
