// Browser-consent OAuth for hosted MCP servers. Implements the SDK's OAuthClientProvider
// backed by a JSON cache file (dynamic client registration + PKCE + tokens), and an
// interactive `authenticate()` driver: spin a localhost callback, open the authorize URL,
// let the *user* log in + consent, capture the code, exchange for tokens. We never see the
// user's password. The capture tools (contract/lint/docs) reuse the cached provider so the
// SDK auto-refreshes expired access tokens.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthClientInformationContext,
  type StoredOAuthTokens,
  type StoredOAuthClientInformation,
  type OAuthClientMetadata,
} from "@modelcontextprotocol/client";

interface IssuerEntry {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
}

interface CacheState {
  /**
   * Keyed by the authorization server's `issuer` identifier (SEP-2352 — credentials MUST
   * be bound to the issuing authorization server, MUST NOT be reused across a different
   * one). Legacy (pre-issuer-keying) caches land under `""` on migration.
   */
  byIssuer: Record<string, IssuerEntry>;
  /**
   * Most-recently-touched issuer — used when a caller asks with no `ctx` (the transport's
   * per-request bearer-token read, per `OAuthClientProvider.tokens()`'s own contract: "do
   * not return undefined for ctx === undefined").
   */
  lastIssuer?: string;
  codeVerifier?: string;
}

/** Old (pre-issuer-keying) on-disk shape — migrated into `byIssuer[""]` on load. */
interface LegacyCacheState {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
}

function isLegacyCacheState(s: unknown): s is LegacyCacheState {
  return !!s && typeof s === "object" && !("byIssuer" in s) && ("clientInformation" in s || "tokens" in s || "codeVerifier" in s);
}

function readCacheState(file: string): CacheState {
  if (!existsSync(file)) return { byIssuer: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (isLegacyCacheState(parsed)) {
    return {
      byIssuer: { "": { clientInformation: parsed.clientInformation, tokens: parsed.tokens } },
      lastIssuer: "",
      codeVerifier: parsed.codeVerifier,
    };
  }
  const s = parsed as CacheState;
  return { byIssuer: s.byIssuer ?? {}, lastIssuer: s.lastIssuer, codeVerifier: s.codeVerifier };
}

/**
 * Some servers return `"refresh_token": null` (and other null-valued optional fields) from
 * the token endpoint. OAuth semantics say null ≡ absent, but the SDK's zod schema
 * (`z.string().optional()`) rejects null outright — so strip null-valued keys from any
 * token-endpoint-shaped JSON body. Exported for tests.
 */
export function normalizeTokenJson(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  if (!("access_token" in parsed)) return parsed;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null) {
      changed = true;
      continue;
    }
    out[k] = v;
  }
  return changed ? out : parsed;
}

/** A fetch that rewrites token-endpoint responses through `normalizeTokenJson`. */
export const tokenNormalizingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!(res.headers.get("content-type") ?? "").includes("json")) return res;
  const body = await res.text();
  let rewritten = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    const normalized = normalizeTokenJson(parsed);
    if (normalized !== parsed) rewritten = JSON.stringify(normalized);
  } catch {
    /* non-JSON despite the header — pass through untouched */
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(rewritten, { status: res.status, statusText: res.statusText, headers });
};

/** Where a server's OAuth state is cached, keyed by host. */
export function tokenCachePath(url: string): string {
  const host = new URL(url).host.replace(/[^a-z0-9.-]/gi, "_");
  return join(homedir(), ".mcp-query", "oauth", `${host}.json`);
}

/**
 * A file-backed OAuthClientProvider. `interactive: false` refuses to start a new flow.
 * Credentials are stored per authorization-server `issuer` (SEP-2352) — a host can front
 * more than one issuer over its lifetime (e.g. a migration), and this provider must never
 * hand back a different issuer's client registration or tokens.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  lastAuthorizationUrl?: URL;
  private cache: CacheState;

  constructor(
    private readonly file: string,
    private readonly opts: { redirectUrl?: string; scope?: string; interactive?: boolean } = {},
  ) {
    this.cache = readCacheState(file);
  }

  private persist(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
  }

  private entry(issuer: string): IssuerEntry {
    return (this.cache.byIssuer[issuer] ??= {});
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl ?? "http://localhost/callback";
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "mcp-query",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      // SEP-837: retry-with-adjusted-metadata registration negotiation may ask for a
      // different application_type; "native" matches this CLI's localhost-callback flow.
      application_type: "native",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const issuer = ctx?.issuer ?? this.cache.lastIssuer;
    return issuer === undefined ? undefined : this.cache.byIssuer[issuer]?.clientInformation;
  }
  saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void {
    const issuer = ctx?.issuer ?? "";
    this.entry(issuer).clientInformation = info;
    this.cache.lastIssuer = issuer;
    this.persist();
  }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const issuer = ctx?.issuer ?? this.cache.lastIssuer;
    return issuer === undefined ? undefined : this.cache.byIssuer[issuer]?.tokens;
  }
  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    const issuer = ctx?.issuer ?? "";
    this.entry(issuer).tokens = tokens;
    this.cache.lastIssuer = issuer;
    this.persist();
  }
  saveCodeVerifier(v: string): void {
    this.cache.codeVerifier = v;
    this.persist();
  }
  codeVerifier(): string {
    if (!this.cache.codeVerifier) throw new Error("no PKCE code verifier saved");
    return this.cache.codeVerifier;
  }
  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.opts.interactive) {
      // Name the command the user actually ran: under the mcp-query umbrella the fix is
      // `mcp-query login`, standalone it's `mcp-contract auth` (mcp-query sets MCPQ_UMBRELLA).
      throw new Error(
        process.env.MCPQ_UMBRELLA === "1"
          ? `authorization required — run:  mcp-query login <name|url>`
          : `authorization required — run:  mcp-contract auth --url <server>`,
      );
    }
    this.lastAuthorizationUrl = authorizationUrl;
  }
}

/** A non-interactive provider for the capture path (auto-refresh only; never prompts). */
export function captureProvider(url: string): FileOAuthProvider {
  return new FileOAuthProvider(tokenCachePath(url), { interactive: false });
}

/** True when a usable cached token (or refresh token) exists for `url`, for any issuer. */
export function hasCachedAuth(url: string): boolean {
  try {
    const s = readCacheState(tokenCachePath(url));
    return Object.values(s.byIssuer).some((e) => !!e.tokens?.access_token);
  } catch {
    return false;
  }
}

function startCallbackServer(fixedPort?: number): Promise<{ port: number; code: Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let resolveCode: (c: string) => void;
    const code = new Promise<string>((r) => (resolveCode = r));
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      const c = u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><body style="font-family:sans-serif"><h2>${c ? "✓ Authorized" : "No code received"}</h2><p>You may close this tab and return to the terminal.</p>`);
      if (c) resolveCode(c);
    });
    server.on("error", reject);
    // A fixed port (0 → ephemeral) lets a remote box be reached via `ssh -L PORT:localhost:PORT`.
    server.listen(fixedPort ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, code, close: () => server.close() });
    });
  });
}

function pasteFallback(redirectUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`If your browser is on another machine, paste the full redirected URL (${redirectUrl}?code=…) here:\n> `, (line) => {
      rl.close();
      try {
        const code = new URL(line.trim()).searchParams.get("code");
        if (code) resolve(code);
      } catch {
        if (line.trim()) resolve(line.trim()); // allow pasting the bare code
      }
    });
  });
}

/** Platform-appropriate launcher; candidates after the first are Linux fallbacks. */
function browserCommands(): string[] {
  if (process.platform === "darwin") return ["open"];
  if (process.platform === "win32") return ["explorer"];
  return ["xdg-open", "google-chrome-stable", "chromium"];
}

function openInBrowser(url: URL): void {
  // Best-effort on every path: spawn() throws synchronously on some invalid inputs, but a
  // missing binary surfaces as an async 'error' event — without a listener that event is
  // fatal and would kill the login flow, whose printed URL / paste prompt IS the fallback.
  const tryOpen = (cmds: string[]): void => {
    const [cmd, ...rest] = cmds;
    if (!cmd) return;
    try {
      const child = spawn(cmd, [url.toString()], {
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" },
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => tryOpen(rest));
      child.unref();
    } catch {
      tryOpen(rest);
    }
  };
  tryOpen(browserCommands());
}

export interface AuthenticateOptions {
  scope?: string;
  /** Also write the raw tokens JSON here (besides the per-host cache). */
  out?: string;
  /** Attempt to open the authorize URL in a local browser. Default true. */
  open?: boolean;
  /** Fixed callback port (default ephemeral). Set this to forward it over `ssh -L`. */
  port?: number;
  /** Overall wait for consent (ms). Default 5 min. */
  timeoutMs?: number;
}

/** Run the interactive browser-consent flow and return the obtained tokens. */
export async function authenticate(url: string, opts: AuthenticateOptions = {}): Promise<StoredOAuthTokens> {
  const cb = await startCallbackServer(opts.port);
  const redirectUrl = `http://localhost:${cb.port}/callback`;
  const provider = new FileOAuthProvider(tokenCachePath(url), { redirectUrl, scope: opts.scope, interactive: true });
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider, fetch: tokenNormalizingFetch });
  const client = new Client({ name: "mcp-contract-auth", version: "0.0.1" }, { capabilities: {} });

  try {
    await client.connect(transport); // succeeds if cached tokens are still valid
    await client.close();
    cb.close();
    return provider.tokens()!;
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) {
      cb.close();
      throw e;
    }
  }

  const authUrl = provider.lastAuthorizationUrl;
  if (!authUrl) {
    cb.close();
    throw new Error("authorization URL was not produced by the SDK");
  }
  console.error(`\nDynamic client registered. Open this URL in the browser where you're logged in, and approve:\n\n  ${authUrl}\n`);
  console.error(`Waiting for the callback on ${redirectUrl} —`);
  console.error(`  • browser on THIS machine → it just works`);
  console.error(`  • browser on another machine → forward the port:  ssh -L ${cb.port}:localhost:${cb.port} <this-host>`);
  console.error(`  • or just paste the redirected URL at the prompt below.\n`);
  if (opts.open ?? true) openInBrowser(authUrl);

  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for authorization")), opts.timeoutMs ?? 300_000).unref());
  const code = await Promise.race([cb.code, pasteFallback(redirectUrl), timeout]);

  await transport.finishAuth(code); // exchanges code → tokens, provider.saveTokens persists to cache
  cb.close();
  const tokens = provider.tokens();
  if (!tokens) throw new Error("token exchange did not yield tokens");
  if (opts.out) writeFileSync(opts.out, JSON.stringify(tokens, null, 2));
  await client.close().catch(() => {});
  return tokens;
}
