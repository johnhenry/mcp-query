// Browser-side OAuth for the *direct* HTTP/SSE connection mode (no proxy). Running the
// flow in the browser is what makes it observable: every step goes through
// instrumentAuthProvider → the devtools `auth` event. Tokens live in sessionStorage
// (a dev tool) and are redacted in the step log.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export class BrowserOAuthProvider implements OAuthClientProvider {
  constructor(private serverName: string) {}
  private k(s: string): string {
    return `mcp-oauth:${this.serverName}:${s}`;
  }

  get redirectUrl(): string {
    return location.origin + location.pathname;
  }

  get clientMetadata() {
    return {
      client_name: "mcp-query app",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "",
    };
  }

  state(): string {
    let s = sessionStorage.getItem(this.k("state"));
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem(this.k("state"), s); }
    return s;
  }

  clientInformation() {
    const raw = sessionStorage.getItem(this.k("client"));
    return raw ? JSON.parse(raw) : undefined;
  }
  saveClientInformation(info: unknown): void {
    sessionStorage.setItem(this.k("client"), JSON.stringify(info));
  }

  tokens() {
    const raw = sessionStorage.getItem(this.k("tokens"));
    return raw ? JSON.parse(raw) : undefined;
  }
  saveTokens(tokens: unknown): void {
    sessionStorage.setItem(this.k("tokens"), JSON.stringify(tokens));
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

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    const map: Record<string, string[]> = {
      all: ["state", "client", "tokens", "verifier"],
      client: ["client"],
      tokens: ["tokens"],
      verifier: ["verifier"],
    };
    for (const s of map[scope] ?? []) sessionStorage.removeItem(this.k(s));
  }
}
