import { describe, it, expect } from "vitest";
import { instrumentAuthProvider } from "../src/core/authDebug.js";
import { applyInboundAuth } from "../src/server/inboundAuth.js";
import { AuthorizationError } from "../src/server/authorize.js";

// Fakes stand in for the SDK so these run on the lockfile's 2.0.0 (no DPoP there).
const CIMD = "https://client.example/oauth/client.json";
const metadata = {
  issuer: "https://as.example",
  client_id_metadata_document_supported: true,
  registration_endpoint: "https://as.example/register",
  authorization_response_iss_parameter_supported: true,
  dpop_signing_alg_values_supported: ["ES256"],
};

function fakeProvider() {
  return {
    clientMetadataUrl: CIMD,
    get redirectUrl() {
      return "http://localhost:8976/callback";
    },
    clientInformation: (_ctx?: unknown) => ({ client_id: CIMD, client_secret: "SECRET-CS" }),
    saveClientInformation(_i: unknown, _ctx?: unknown) {},
    saveDiscoveryState(_s: unknown) {},
    discoveryState() {
      return { authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata };
    },
    codeVerifier: () => "PKCE-VERIFIER",
    async dpop() {
      return { thumbprint: "thumb-123", alg: "ES256", privateKey: "PRIVATE-KEY-MATERIAL", publicJwk: { d: "PRIVATE-D" } };
    },
  };
}

describe("withAuthDebug / instrumentAuthProvider: registration, issuer check, DPoP", () => {
  it("records CIMD vs DCR for the stored client, never the secret", () => {
    const p = instrumentAuthProvider(fakeProvider());
    p.saveClientInformation({ client_id: CIMD }, { issuer: "https://as.example" });
    p.saveClientInformation({ client_id: "dcr-1", client_secret: "SECRET-CS" }, { issuer: "https://as.example" });
    p.clientInformation({ issuer: "https://as.example" });
    const regs = p.authSteps().filter((s) => (s.detail as { registration?: string } | undefined)?.registration);
    expect(regs.map((s) => (s.detail as { registration: string }).registration)).toEqual(["cimd", "dcr", "cimd"]);
    expect(JSON.stringify(p.authSteps())).not.toContain("SECRET-CS");
  });

  it("records what discovery offered: CIMD support, DCR availability, iss support, DPoP algs", () => {
    const p = instrumentAuthProvider(fakeProvider());
    p.saveDiscoveryState({ authorizationServerUrl: metadata.issuer, authorizationServerMetadata: metadata });
    const step = p.authSteps().find((s) => s.member === "saveDiscoveryState" && s.phase === "call");
    expect(step?.detail).toMatchObject({
      issuer: "https://as.example",
      cimdSupported: true,
      dcrAvailable: true,
      issParameterSupported: true,
      dpopAlgs: ["ES256"],
    });
  });

  it("records the issuer check as passed when the code-exchange leg starts, redacting the verifier", () => {
    const p = instrumentAuthProvider(fakeProvider());
    p.discoveryState();
    p.codeVerifier();
    const check = p.authSteps().find((s) => s.member === "issuerCheck");
    expect(check?.detail).toMatchObject({ recordedIssuer: "https://as.example", issParameterSupported: true });
    expect(JSON.stringify(p.authSteps())).not.toContain("PKCE-VERIFIER");
  });

  it("records DPoP as the key thumbprint only", async () => {
    const p = instrumentAuthProvider(fakeProvider());
    await p.dpop();
    const dump = JSON.stringify(p.authSteps());
    const step = p.authSteps().find((s) => s.member === "dpop" && s.phase === "resolved");
    expect(step?.detail).toEqual({ thumbprint: "thumb-123", alg: "ES256" });
    expect(dump).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(dump).not.toContain("PRIVATE-D");
  });

  it("authNote lets a host add its own step", () => {
    const p = instrumentAuthProvider(fakeProvider());
    p.authNote("dpopProof", { htm: "POST", thumbprint: "thumb-123" });
    expect(p.authSteps().at(-1)).toMatchObject({ member: "dpopProof", detail: { htm: "POST" } });
  });
});

describe("applyInboundAuth", () => {
  const auth = { clientId: "svc-1", scopes: ["mcp", "tools"], extra: { sub: "alice" } };

  it("is a no-op when disabled", () => {
    const meta = { principal: "claimed" };
    expect(applyInboundAuth(meta, auth, undefined)).toBe(meta);
  });

  it("maps the verified principal and drops caller-claimed verifier-owned keys", () => {
    const out = applyInboundAuth({ principal: "mallory", authScopes: ["admin"], trace: "t1" }, auth, true);
    expect(out).toEqual({ trace: "t1", principal: "alice", authScopes: ["mcp", "tools"], authClientId: "svc-1" });
  });

  it("falls back to clientId, and a custom principal mapper wins", () => {
    expect(applyInboundAuth(undefined, { clientId: "svc-1", scopes: [] }, true)).toMatchObject({ principal: "svc-1" });
    expect(applyInboundAuth(undefined, auth, { principal: (a) => `tenant:${a.clientId}` })).toMatchObject({ principal: "tenant:svc-1" });
  });

  it("strips a spoofed principal when nothing was verified, and rejects when required", () => {
    expect(applyInboundAuth({ principal: "mallory", x: 1 }, undefined, true)).toEqual({ x: 1 });
    expect(applyInboundAuth({ principal: "mallory" }, undefined, true)).toEqual({});
    expect(applyInboundAuth(undefined, undefined, true)).toBeUndefined();
    expect(() => applyInboundAuth(undefined, undefined, { required: true })).toThrow(AuthorizationError);
  });
});
