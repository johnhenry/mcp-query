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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens, OAuthClientInformationMixed, OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";

interface CacheState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** Where a server's OAuth state is cached, keyed by host. */
export function tokenCachePath(url: string): string {
  const host = new URL(url).host.replace(/[^a-z0-9.-]/gi, "_");
  return join(homedir(), ".mcp-query", "oauth", `${host}.json`);
}

/** A file-backed OAuthClientProvider. `interactive: false` refuses to start a new flow. */
export class FileOAuthProvider implements OAuthClientProvider {
  lastAuthorizationUrl?: URL;
  private cache: CacheState;

  constructor(
    private readonly file: string,
    private readonly opts: { redirectUrl?: string; scope?: string; interactive?: boolean } = {},
  ) {
    this.cache = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CacheState) : {};
  }

  private persist(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
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
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.cache.clientInformation;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.cache.clientInformation = info;
    this.persist();
  }
  tokens(): OAuthTokens | undefined {
    return this.cache.tokens;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.cache.tokens = tokens;
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
      throw new Error(`authorization required — run:  mcp-contract auth --url <server>`);
    }
    this.lastAuthorizationUrl = authorizationUrl;
  }
}

/** A non-interactive provider for the capture path (auto-refresh only; never prompts). */
export function captureProvider(url: string): FileOAuthProvider {
  return new FileOAuthProvider(tokenCachePath(url), { interactive: false });
}

/** True when a usable cached token (or refresh token) exists for `url`. */
export function hasCachedAuth(url: string): boolean {
  try {
    const s = JSON.parse(readFileSync(tokenCachePath(url), "utf8")) as CacheState;
    return !!s.tokens?.access_token;
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
      res.writeHead(200, { "content-type": "text/html" });
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

function openInBrowser(url: URL): void {
  try {
    spawn("google-chrome-stable", [url.toString()], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" }, stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort; the printed URL is the fallback */
  }
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
export async function authenticate(url: string, opts: AuthenticateOptions = {}): Promise<OAuthTokens> {
  const cb = await startCallbackServer(opts.port);
  const redirectUrl = `http://localhost:${cb.port}/callback`;
  const provider = new FileOAuthProvider(tokenCachePath(url), { redirectUrl, scope: opts.scope, interactive: true });
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
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
