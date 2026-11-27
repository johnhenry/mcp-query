// Browser-consent OAuth for hosted MCP servers. Implements the SDK's OAuthClientProvider
// backed by a JSON cache file (dynamic client registration + PKCE + tokens), and an
// interactive `authenticate()` driver: spin a localhost callback, open the authorize URL,
// let the *user* log in + consent, capture the code, exchange for tokens. We never see the
// user's password. The capture tools (contract/lint/docs) reuse the cached provider so the
// SDK auto-refreshes expired access tokens.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
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
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_CALLBACK_PORT,
  DEFAULT_CLIENT_METADATA_REDIRECT_URIS,
  isValidClientMetadataUrl,
  resolveClientMetadataUrl,
} from "./clientMetadata.js";
import { assertDpopSupported, dpopKeyPath, loadOrCreateDpopSession, type DpopSessionLike } from "./dpop.js";

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
  /** RFC 9728 / RFC 8414 discovery results, persisted so the callback leg can check the issuer binding. */
  discovery?: OAuthDiscoveryState;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return { byIssuer: {} }; // unreadable/corrupt cache: ignore it rather than crash a login
  }
  if (!parsed || typeof parsed !== "object") return { byIssuer: {} };
  if (isLegacyCacheState(parsed)) {
    return {
      byIssuer: { "": { clientInformation: parsed.clientInformation, tokens: parsed.tokens } },
      lastIssuer: "",
      codeVerifier: parsed.codeVerifier,
    };
  }
  const s = parsed as CacheState;
  const byIssuer = s.byIssuer && typeof s.byIssuer === "object" ? s.byIssuer : {};
  return { byIssuer, lastIssuer: s.lastIssuer, codeVerifier: s.codeVerifier, discovery: s.discovery };
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
export interface FileOAuthProviderOptions {
  redirectUrl?: string;
  scope?: string;
  interactive?: boolean;
  /**
   * Client ID Metadata Document URL. Default: `MCPQ_CLIENT_METADATA_URL` or the checked-in
   * document's URL; `false` (or env `off`) disables CIMD so only Dynamic Client Registration
   * is used. The SDK uses it only when the authorization server advertises
   * `client_id_metadata_document_supported`, otherwise it registers dynamically.
   */
  clientMetadataUrl?: string | false;
  /** Pin the authorization server: discovery that resolves any other issuer is rejected. */
  expectedIssuer?: string;
  /** Opt in to DPoP (RFC 9449) sender-constrained tokens. Needs SDK >= 2.1.0. */
  dpop?: boolean;
}

/** The SDK's `OAuthClientProvider.dpop` type when the installed SDK declares it, else this package's slice. */
type SdkDpopMember = OAuthClientProvider extends { dpop?: infer D }
  ? unknown extends D
    ? () => Promise<DpopSessionLike>
    : NonNullable<D>
  : () => Promise<DpopSessionLike>;

export class FileOAuthProvider implements OAuthClientProvider {
  lastAuthorizationUrl?: URL;
  private cache: CacheState;
  private dpopPromise?: Promise<DpopSessionLike>;
  /**
   * Present only when constructed with `dpop: true`; the SDK detects DPoP by this member.
   * Typed from the installed SDK's own `OAuthClientProvider.dpop` where it has one (>= 2.1.0, whose
   * `DpopSession` is wider than the slice this package uses), so the class type-checks on every
   * supported SDK; on older SDKs, which have no such member, it is this package's own shape.
   */
  dpop?: SdkDpopMember;
  private readonly cimdUrl: string | undefined;

  constructor(
    private readonly file: string,
    private readonly opts: FileOAuthProviderOptions = {},
  ) {
    this.cache = readCacheState(file);
    const explicit = opts.clientMetadataUrl;
    this.cimdUrl = resolveClientMetadataUrl(explicit);
    if (opts.dpop) {
      assertDpopSupported();
      const keyFile = dpopKeyPath(file);
      // The session comes from the SDK's own `DpopSession.create`, so it is the SDK's type at runtime.
      this.dpop = (() => (this.dpopPromise ??= loadOrCreateDpopSession(keyFile))) as SdkDpopMember;
    }
  }

  /**
   * The CIMD URL handed to the SDK, or undefined when CIMD cannot work for this run. The
   * checked-in document lists fixed loopback redirect URIs, so with the default URL we only
   * offer it when this run's redirect URL is one of them; an explicit URL (flag/env/option)
   * is the caller's responsibility.
   */
  get clientMetadataUrl(): string | undefined {
    const url = this.cimdUrl;
    if (!url || !isValidClientMetadataUrl(url)) return undefined;
    const explicit = this.opts.clientMetadataUrl !== undefined || process.env.MCPQ_CLIENT_METADATA_URL !== undefined;
    if (!explicit && !DEFAULT_CLIENT_METADATA_REDIRECT_URIS.includes(this.redirectUrl)) return undefined;
    return url;
  }

  /** The issuer whose credentials were touched most recently ("" for legacy/no-ctx saves). */
  lastIssuerKey(): string | undefined {
    return this.cache.lastIssuer;
  }

  /** Which registration mechanism produced the stored client for `issuer` (for logs/UX). */
  registrationMethod(issuer?: string): "cimd" | "dcr" | undefined {
    const info = this.clientInformation(issuer === undefined ? undefined : { issuer });
    if (!info) return undefined;
    return this.cimdUrl && info.client_id === this.cimdUrl ? "cimd" : "dcr";
  }

  private persist(): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600); // tokens live here: owner-only even if the file pre-existed
  }

  /**
   * SEP-2352 callback-leg binding: the SDK records discovery before redirecting and checks the
   * re-discovered issuer against it when the code comes back. `expectedIssuer` additionally
   * pins which authorization server this host may use at all.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.cache.discovery;
  }
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const issuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
    const want = this.opts.expectedIssuer;
    if (want !== undefined && issuer !== undefined && issuer !== want) {
      throw new Error(`authorization server issuer mismatch: expected "${want}" but discovery resolved "${issuer}" — refusing to continue`);
    }
    this.cache.discovery = state;
    this.persist();
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
    if (this.opts.expectedIssuer !== undefined && ctx?.issuer !== undefined && ctx.issuer !== this.opts.expectedIssuer) {
      throw new Error(`authorization server issuer mismatch: expected "${this.opts.expectedIssuer}" but got "${ctx.issuer}"`);
    }
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

/** What the callback carried: the code (or error) plus RFC 9207's `iss`. */
function startCallbackServer(fixedPort?: number): Promise<{ port: number; params: Promise<URLSearchParams>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let resolveParams: (p: URLSearchParams) => void;
    const params = new Promise<URLSearchParams>((r) => (resolveParams = r));
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      const ok = u.searchParams.has("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // Never echo callback parameters: on an issuer mix-up they are attacker-controlled.
      res.end(`<!doctype html><body style="font-family:sans-serif"><h2>${ok ? "✓ Authorized" : "No code received"}</h2><p>You may close this tab and return to the terminal.</p>`);
      if (ok || u.searchParams.has("error")) resolveParams(u.searchParams);
    });
    server.on("error", reject);
    // A fixed port (0 → ephemeral) lets a remote box be reached via `ssh -L PORT:localhost:PORT`.
    server.listen(fixedPort ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, params, close: () => server.close() });
    });
  });
}

function pasteFallback(redirectUrl: string): { params: Promise<URLSearchParams>; cancel: () => void } {
  let cancel = () => {};
  const params = new Promise<URLSearchParams>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    cancel = () => rl.close(); // stop reading stdin once the callback server won the race
    rl.question(`If your browser is on another machine, paste the full redirected URL (${redirectUrl}?code=…) here:\n> `, (line) => {
      rl.close();
      try {
        const p = new URL(line.trim()).searchParams;
        if (p.has("code") || p.has("error")) resolve(p);
      } catch {
        if (line.trim()) resolve(new URLSearchParams({ code: line.trim() })); // allow pasting the bare code
      }
    });
  });
  return { params, cancel: () => cancel() };
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
  /** Fixed callback port (default: the CIMD document's port when CIMD is enabled, else ephemeral). */
  port?: number;
  /** Overall wait for consent (ms). Default 5 min. */
  timeoutMs?: number;
  /** CIMD URL override (`false` disables CIMD); see {@link FileOAuthProviderOptions.clientMetadataUrl}. */
  clientMetadataUrl?: string | false;
  /** Pin the authorization server's issuer. */
  expectedIssuer?: string;
  /** Opt in to DPoP-bound tokens (SDK >= 2.1.0). */
  dpop?: boolean;
}

/** Bind the callback server: prefer the CIMD document's port, fall back to ephemeral if busy. */
async function bindCallback(opts: AuthenticateOptions): Promise<Awaited<ReturnType<typeof startCallbackServer>>> {
  if (opts.port !== undefined) return startCallbackServer(opts.port);
  if (resolveClientMetadataUrl(opts.clientMetadataUrl)) {
    try {
      return await startCallbackServer(DEFAULT_CALLBACK_PORT);
    } catch {
      /* port busy: use an ephemeral one; the provider then registers dynamically */
    }
  }
  return startCallbackServer(undefined);
}

/** Run the interactive browser-consent flow and return the obtained tokens. */
export async function authenticate(url: string, opts: AuthenticateOptions = {}): Promise<StoredOAuthTokens> {
  const cb = await bindCallback(opts);
  const redirectUrl = `http://localhost:${cb.port}/callback`;
  const provider = new FileOAuthProvider(tokenCachePath(url), {
    redirectUrl,
    scope: opts.scope,
    interactive: true,
    clientMetadataUrl: opts.clientMetadataUrl,
    expectedIssuer: opts.expectedIssuer,
    dpop: opts.dpop,
  });
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
  const how = provider.registrationMethod(provider.lastIssuerKey());
  console.error(
    `\n${how === "cimd" ? `Client ID Metadata Document in use (${provider.clientMetadataUrl}).` : "Dynamic client registration used (the authorization server does not advertise Client ID Metadata Document support, or CIMD is off)."}` +
      `${opts.dpop ? " DPoP enabled." : ""}`,
  );
  console.error(`Open this URL in the browser where you're logged in, and approve:\n\n  ${authUrl}\n`);
  console.error(`Waiting for the callback on ${redirectUrl} —`);
  console.error(`  • browser on THIS machine → it just works`);
  console.error(`  • browser on another machine → forward the port:  ssh -L ${cb.port}:localhost:${cb.port} <this-host>`);
  console.error(`  • or just paste the redirected URL at the prompt below.\n`);
  if (opts.open ?? true) openInBrowser(authUrl);

  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out waiting for authorization")), opts.timeoutMs ?? 300_000).unref());
  const paste = pasteFallback(redirectUrl);
  let callbackParams: URLSearchParams;
  try {
    callbackParams = await Promise.race([cb.params, paste.params, timeout]);
  } finally {
    paste.cancel();
  }

  // Hands the whole callback (code, `iss`, error) to the SDK, which validates `iss` against
  // the recorded issuer (RFC 9207) before the code is redeemed; on a mismatch it throws
  // without surfacing the callback's error text.
  await transport.finishAuth(callbackParams);
  cb.close();
  const tokens = provider.tokens();
  if (!tokens) throw new Error("token exchange did not yield tokens");
  if (opts.out) writeFileSync(opts.out, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await client.close().catch(() => {});
  return tokens;
}
