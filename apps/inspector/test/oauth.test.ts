// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { instrumentAuthProvider, type AuthStep } from "mcp-query";
import { BrowserOAuthProvider } from "../src/lib/oauth.js";

beforeEach(() => sessionStorage.clear());

describe("BrowserOAuthProvider", () => {
  it("round-trips tokens + client info in sessionStorage, namespaced per server", () => {
    const a = new BrowserOAuthProvider("srvA");
    expect(a.tokens()).toBeUndefined();
    a.saveTokens({ access_token: "AAA" });
    a.saveClientInformation({ client_id: "cid" });
    expect(a.tokens()).toEqual({ access_token: "AAA" });
    expect(a.clientInformation()).toEqual({ client_id: "cid" });
    expect(new BrowserOAuthProvider("srvB").tokens()).toBeUndefined(); // isolated
  });

  it("invalidateCredentials clears only the requested scope", () => {
    const p = new BrowserOAuthProvider("s");
    p.saveTokens({ access_token: "x" });
    p.saveClientInformation({ client_id: "c" });
    p.invalidateCredentials("tokens");
    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toEqual({ client_id: "c" });
    p.invalidateCredentials("all");
    expect(p.clientInformation()).toBeUndefined();
  });

  it("advertises a browser redirect URI and PKCE-capable metadata", () => {
    const p = new BrowserOAuthProvider("s");
    expect(p.redirectUrl).toBe(location.origin + location.pathname);
    expect(p.clientMetadata.response_types).toContain("code");
    expect(p.clientMetadata.grant_types).toContain("authorization_code");
  });
});

describe("instrumented OAuth (the debugger feed)", () => {
  it("records each step with secrets redacted", () => {
    const steps: AuthStep[] = [];
    const p = instrumentAuthProvider(new BrowserOAuthProvider("s"), (s) => steps.push(s)) as BrowserOAuthProvider & {
      authSteps: () => readonly AuthStep[];
    };
    p.saveTokens({ access_token: "SECRET", refresh_token: "R" });
    p.tokens();

    const saved = steps.find((s) => s.member === "saveTokens" && s.phase === "call");
    expect(saved).toBeTruthy();
    expect(JSON.stringify(saved!.detail)).not.toContain("SECRET");
    expect(saved!.detail).toMatchObject({ hasAccessToken: true, hasRefreshToken: true });
    expect(p.authSteps().length).toBeGreaterThan(0);
  });
});
