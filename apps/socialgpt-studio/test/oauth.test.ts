import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs helper, no types
import { pkce, buildAuthUrl, chooseScope, tokenFile } from "../backend/oauth.mjs";

const META = {
  authorization_endpoint: "https://mcp.gpt.social/oauth/authorize",
  token_endpoint: "https://mcp.gpt.social/oauth/token",
  registration_endpoint: "https://mcp.gpt.social/oauth/register",
  scopes_supported: ["analysis:read", "analysis:read:public", "content:ingest", "offline_access"],
};

describe("oauth helpers", () => {
  it("pkce produces a url-safe verifier and S256 challenge", async () => {
    const { verifier, challenge } = await pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("="); // base64url, unpadded
  });

  it("chooseScope picks the widest supported read scopes (incl. public + refresh)", () => {
    expect(chooseScope(META).split(" ").sort()).toEqual(["analysis:read", "analysis:read:public", "offline_access"]);
    // falls back gracefully when public isn't offered
    expect(chooseScope({ scopes_supported: ["analysis:read", "offline_access"] })).toBe("analysis:read offline_access");
  });

  it("buildAuthUrl carries PKCE, the resource indicator, and the redirect", () => {
    const url = new URL(
      buildAuthUrl(META, {
        clientId: "abc",
        redirectUri: "http://localhost:8787/auth/callback",
        scope: "analysis:read offline_access",
        challenge: "CHAL",
        state: "STATE",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://mcp.gpt.social/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("code_challenge")).toBe("CHAL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/auth/callback");
    expect(url.searchParams.get("resource")).toBe("https://mcp.gpt.social/mcp");
  });

  it("tokenFile is shaped for the /mcp proxy + refresh (client_id + tokens + verifier)", () => {
    const f = tokenFile({ clientId: "cid", redirectUri: "http://localhost:8787/auth/callback", verifier: "v", tokens: { access_token: "AT", refresh_token: "RT" } });
    expect(f.clientInformation.client_id).toBe("cid");
    expect(f.tokens.access_token).toBe("AT");
    expect(f.codeVerifier).toBe("v");
  });
});
