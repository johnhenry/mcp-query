// Browser-side OAuth for the *direct* HTTP/SSE connection mode (no proxy). Running the
// flow in the browser is what makes it observable: every step goes through
// instrumentAuthProvider → the devtools `auth` event → the OAuth debugger panel. Tokens
// live in sessionStorage (a dev tool) and are redacted in the step log.
//
// Registration: a Client ID Metadata Document (CIMD) is preferred, Dynamic Client
// Registration (DCR) is the fallback. The SDK uses `clientMetadataUrl` only when the
// authorization server advertises `client_id_metadata_document_supported`; this provider
// additionally refuses to offer the document when it is switched off, when this page's
// redirect URI is not one the document lists, or when the document cannot be fetched or is
// inconsistent — and records why, so the OAuth debugger can say which path was taken and why.

import { instrumentAuthProvider, type AuthStep } from "@johnhenry/mcp-query";
import type { OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

/**
 * The inspector's own Client ID Metadata Document (it is a browser app with a different
 * redirect URI from the CLI, so it cannot share the CLI's document). The single constant for
 * its public URL — also its `client_id`. Served by GitHub Pages (`application/json`) from
 * `oauth/inspector-client-metadata.json` at the repo root once that file is on `main`.
 * Override at build time with `VITE_INSPECTOR_CLIENT_METADATA_URL` (an https URL, or `off`).
 */
export const INSPECTOR_CLIENT_METADATA_URL = "https://johnhenry.github.io/mcp-query/oauth/inspector-client-metadata.json";

/** CIMD requires an https URL with a path component. */
export function isValidClientMetadataUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.pathname !== "/" && !u.hash;
  } catch {
    return false;
  }
}

/** Resolve the effective URL: explicit option > build-time env > constant. `false`/`off` disables CIMD. */
export function resolveClientMetadataUrl(explicit?: string | false, env?: string): string | undefined {
  const raw = explicit !== undefined ? explicit : env !== undefined ? env : INSPECTOR_CLIENT_METADATA_URL;
  if (raw === false) return undefined;
  const v = raw.trim();
  if (v === "" || /^(off|false|0|none)$/i.test(v)) return undefined;
  if (!isValidClientMetadataUrl(v)) throw new Error(`client metadata URL must be an https URL with a path (got "${v}")`);
  return v;
}

/** Why the Client ID Metadata Document was (not) offered to the SDK for this run. */
export interface CimdOffer {
  offered: boolean;
  url?: string;
  /** Plain-language reason, recorded in the stepper. */
  reason: string;
}

type Scope = "all" | "client" | "tokens" | "verifier" | "discovery";
type Issuer = { issuer?: string } | undefined;

export interface BrowserOAuthOptions {
  /** Override the document URL; `false` disables CIMD (DCR only). */
  clientMetadataUrl?: string | false;
  /** Fetch used to check the document (tests inject one). */
  fetch?: typeof fetch;
  /** Called with a note for the debugger (wired to `authNote` by the store). */
  onNote?: (member: string, detail?: unknown) => void;
}

function viteEnv(): string | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_INSPECTOR_CLIENT_METADATA_URL;
  } catch {
    return undefined;
  }
}

export class BrowserOAuthProvider implements OAuthClientProvider {
  private cimdUrl: string | undefined;
  private cimdOffer: CimdOffer;
  private readonly fetchImpl: typeof fetch;
  private readonly onNote?: (member: string, detail?: unknown) => void;

  constructor(private serverName: string, opts: BrowserOAuthOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.onNote = opts.onNote;
    try {
      this.cimdUrl = resolveClientMetadataUrl(opts.clientMetadataUrl, viteEnv());
      this.cimdOffer = this.cimdUrl
        ? { offered: false, url: this.cimdUrl, reason: "document not checked yet" }
        : { offered: false, reason: "CIMD is switched off for this build (dynamic client registration only)" };
    } catch (e) {
      this.cimdUrl = undefined;
      this.cimdOffer = { offered: false, reason: String((e as Error).message) };
    }
  }
  private k(s: string): string {
    return `mcp-oauth:${this.serverName}:${s}`;
  }

  get redirectUrl(): string {
    return location.origin + location.pathname;
  }

  get clientMetadata() {
    return {
      client_name: "MCP Inspector",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "",
      // http loopback redirects are only valid for native-type clients (OIDC DCR §2).
      ...(isLoopbackHttp(this.redirectUrl) ? { application_type: "native" } : {}),
    };
  }

  /**
   * The CIMD URL handed to the SDK, or undefined when it cannot work for this run (then the
   * SDK registers dynamically). Only defined after `prepare()` has verified the document.
   */
  get clientMetadataUrl(): string | undefined {
    return this.cimdOffer.offered ? this.cimdUrl : undefined;
  }

  /** What `prepare()` decided, for the stepper. */
  cimdDecision(): CimdOffer {
    return this.cimdOffer;
  }

  /**
   * Check the metadata document before the flow starts: reachable, JSON, its `client_id` is its
   * own URL, and it lists this page's redirect URI. Any failure → not offered → DCR.
   * Records the outcome as a `clientMetadataUrl` note.
   */
  async prepare(): Promise<CimdOffer> {
    const url = this.cimdUrl;
    if (!url) return this.finish(this.cimdOffer);
    const no = (reason: string): CimdOffer => this.finish({ offered: false, url, reason });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { accept: "application/json" }, cache: "no-store" });
    } catch (e) {
      return no(`document not reachable (${(e as Error).message || "network error"}); using dynamic client registration`);
    }
    if (!res.ok) return no(`document not reachable (HTTP ${res.status}); using dynamic client registration`);
    let doc: { client_id?: unknown; redirect_uris?: unknown };
    try {
      doc = (await res.json()) as typeof doc;
    } catch {
      return no("document is not valid JSON; using dynamic client registration");
    }
    if (doc.client_id !== url) return no("document's client_id is not its own URL; using dynamic client registration");
    const uris = Array.isArray(doc.redirect_uris) ? (doc.redirect_uris as unknown[]) : [];
    if (!uris.includes(this.redirectUrl)) {
      return no(`document does not list this page's redirect URI (${this.redirectUrl}); using dynamic client registration`);
    }
    return this.finish({ offered: true, url, reason: "document reachable and lists this page's redirect URI" });
  }

  private finish(o: CimdOffer): CimdOffer {
    this.cimdOffer = o;
    this.onNote?.("clientMetadataUrl", { offered: o.offered, url: o.url, reason: o.reason });
    return o;
  }

  state(): string {
    let s = sessionStorage.getItem(this.k("state"));
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem(this.k("state"), s); }
    return s;
  }

  // Credentials are bound to the authorization server that issued them (SEP-2352): stored per
  // issuer, never handed back for a different one. Without a context (the transport's per-request
  // bearer read) the most recently touched issuer is used.
  private read<T>(part: string, ctx?: Issuer): T | undefined {
    const issuer = ctx?.issuer ?? sessionStorage.getItem(this.k("lastIssuer"));
    if (issuer === null || issuer === undefined) return undefined;
    const raw = sessionStorage.getItem(this.k(`${part}@${issuer}`));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }
  private write(part: string, value: unknown, ctx?: Issuer): void {
    const issuer = ctx?.issuer ?? "";
    sessionStorage.setItem(this.k(`${part}@${issuer}`), JSON.stringify(value));
    sessionStorage.setItem(this.k("lastIssuer"), issuer);
  }

  clientInformation(ctx?: Issuer) {
    return this.read<StoredOAuthClientInformation>("client", ctx);
  }
  saveClientInformation(info: StoredOAuthClientInformation, ctx?: Issuer): void {
    this.write("client", info, ctx);
  }

  tokens(ctx?: Issuer) {
    return this.read<StoredOAuthTokens>("tokens", ctx);
  }
  saveTokens(tokens: StoredOAuthTokens, ctx?: Issuer): void {
    this.write("tokens", tokens, ctx);
  }

  // SEP-2352 callback-leg binding: the SDK records discovery before redirecting and compares the
  // re-discovered issuer when the code comes back. Must survive the redirect, so sessionStorage.
  discoveryState() {
    const raw = sessionStorage.getItem(this.k("discovery"));
    return raw ? JSON.parse(raw) : undefined;
  }
  saveDiscoveryState(state: unknown): void {
    sessionStorage.setItem(this.k("discovery"), JSON.stringify(state));
  }

  redirectToAuthorization(url: URL): void {
    location.href = url.toString();
  }

  saveCodeVerifier(v: string): void {
    sessionStorage.setItem(this.k("verifier"), v);
  }
  codeVerifier(): string {
    const v = sessionStorage.getItem(this.k("verifier"));
    if (!v) throw new Error("missing PKCE code verifier");
    return v;
  }

  invalidateCredentials(scope: Scope): void {
    const drop = (parts: string[]) => {
      for (const key of Object.keys(sessionStorage)) {
        if (parts.some((p) => key === this.k(p) || key.startsWith(this.k(`${p}@`)))) sessionStorage.removeItem(key);
      }
    };
    const map: Record<Scope, string[]> = {
      all: ["state", "client", "tokens", "verifier", "discovery", "lastIssuer"],
      client: ["client"],
      tokens: ["tokens"],
      verifier: ["verifier"],
      discovery: ["discovery"],
    };
    drop(map[scope] ?? []);
  }
}

function isLoopbackHttp(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
  } catch {
    return false;
  }
}

export type InstrumentedBrowserProvider = BrowserOAuthProvider & {
  authSteps: () => readonly AuthStep[];
  authNote: (member: string, detail?: unknown) => void;
};

/** The provider wrapped so every step (and the provider's own notes) is recorded for the debugger. */
export function createInstrumentedProvider(name: string, onStep: (s: AuthStep) => void, opts: Omit<BrowserOAuthOptions, "onNote"> = {}): InstrumentedBrowserProvider {
  let wrapped!: InstrumentedBrowserProvider;
  const base = new BrowserOAuthProvider(name, { ...opts, onNote: (m, d) => wrapped.authNote(m, d) });
  wrapped = instrumentAuthProvider(base, onStep) as InstrumentedBrowserProvider;
  return wrapped;
}

/**
 * Whether tokens are stored for `server`, read straight from storage. The debugger panel must not call
 * `provider.tokens()` while rendering: on the instrumented provider that records a step, which re-renders
 * the panel, which reads again.
 */
export function hasStoredTokens(server: string): boolean {
  const last = sessionStorage.getItem(`mcp-oauth:${server}:lastIssuer`);
  return last !== null && sessionStorage.getItem(`mcp-oauth:${server}:tokens@${last}`) !== null;
}
