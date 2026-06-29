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
