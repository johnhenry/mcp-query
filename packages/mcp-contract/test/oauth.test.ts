import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOAuthProvider, captureProvider, hasCachedAuth } from "../src/oauth.js";
import type { OAuthTokens, OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "mcpq-oauth-")), "tokens.json");

describe("FileOAuthProvider", () => {
  it("persists client info, tokens, and code verifier across instances", () => {
    const file = tmpFile();
    const p1 = new FileOAuthProvider(file, { redirectUrl: "http://localhost:7777/callback", interactive: true });
    p1.saveClientInformation({ client_id: "abc", redirect_uris: ["http://localhost:7777/callback"] } as OAuthClientInformationFull);
    p1.saveCodeVerifier("verifier-123");
    p1.saveTokens({ access_token: "tok", token_type: "Bearer" } as OAuthTokens);

    const p2 = new FileOAuthProvider(file); // reload from disk
    expect(p2.clientInformation()?.client_id).toBe("abc");
    expect(p2.codeVerifier()).toBe("verifier-123");
    expect(p2.tokens()?.access_token).toBe("tok");
  });

  it("advertises a public-client metadata document for dynamic registration", () => {
    const p = new FileOAuthProvider(tmpFile(), { redirectUrl: "http://localhost:1/callback", scope: "a b" });
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ["http://localhost:1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: "a b",
    });
  });

  it("a non-interactive (capture) provider refuses to start a new flow", () => {
    const p = captureProvider("https://host.example/mcp");
    expect(() => p.redirectToAuthorization(new URL("https://host.example/oauth/authorize"))).toThrow(/mcp-contract auth/);
  });

  it("hasCachedAuth reflects whether a token is cached for a host", () => {
    expect(hasCachedAuth("https://nope.example/mcp")).toBe(false);
  });
});

describe("token response normalization", () => {
  // Some live servers (e.g. SocialGPT) return `"refresh_token": null` from the token
  // endpoint; the SDK's zod schema (z.string().optional()) rejects null — regression for
  // the fix that strips null-valued fields from token-endpoint-shaped bodies.
  it("strips null-valued fields from token responses", async () => {
    const { normalizeTokenJson } = await import("../src/oauth.js");
    expect(
      normalizeTokenJson({ access_token: "abc", token_type: "Bearer", refresh_token: null, scope: null, expires_in: 3600 }),
    ).toEqual({ access_token: "abc", token_type: "Bearer", expires_in: 3600 });
  });

  it("leaves non-token JSON (and non-objects) untouched", async () => {
    const { normalizeTokenJson } = await import("../src/oauth.js");
    const body = { error: "invalid_grant", detail: null };
    expect(normalizeTokenJson(body)).toBe(body); // no access_token → pass through as-is
    expect(normalizeTokenJson([1, null])).toEqual([1, null]);
    expect(normalizeTokenJson("x")).toBe("x");
  });
});
