import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGate, validateGateConfig, tokenSourceFor, cachedTokenSource, type GateConfig } from "../src/index.js";
import { startMockOauth, CC, ENT, type MockOauth } from "./helpers/mockOauth.js";

let mock: MockOauth;
beforeEach(async () => {
  mock = await startMockOauth();
  process.env.GATE_TEST_CC_SECRET = CC.clientSecret;
  process.env.GATE_TEST_ID_TOKEN = ENT.idToken;
  process.env.GATE_TEST_IDP_SECRET = ENT.idpSecret;
  process.env.GATE_TEST_AS_SECRET = ENT.asSecret;
});
afterEach(async () => {
  await mock.close();
  for (const k of ["GATE_TEST_CC_SECRET", "GATE_TEST_ID_TOKEN", "GATE_TEST_IDP_SECRET", "GATE_TEST_AS_SECRET"]) delete process.env[k];
});

const cc = (over: Record<string, unknown> = {}) =>
  ({ type: "client_credentials", issuer: mock.issuer, clientId: CC.clientId, clientSecret: { env: "GATE_TEST_CC_SECRET" }, ...over }) as never;
const ent = (over: Record<string, unknown> = {}) =>
  ({
    type: "enterprise",
    issuer: mock.issuer,
    idToken: { env: "GATE_TEST_ID_TOKEN" },
    idp: { tokenEndpoint: mock.idpTokenEndpoint, clientId: ENT.idpClientId, clientSecret: { env: "GATE_TEST_IDP_SECRET" } },
    clientId: ENT.asClientId,
    clientSecret: { env: "GATE_TEST_AS_SECRET" },
    ...over,
  }) as never;

describe("validateGateConfig: upstream auth", () => {
  const cfg = (auth: unknown): GateConfig => ({ upstreams: { up: { url: "https://example.com/mcp", auth } as never } });

  it("accepts secret references (env or callback)", () => {
    expect(() => validateGateConfig(cfg({ type: "client_credentials", issuer: "https://as.example", clientId: "c", clientSecret: { env: "X" } }))).not.toThrow();
    expect(() => validateGateConfig(cfg({ type: "client_credentials", issuer: "https://as.example", clientId: "c", clientSecret: { get: () => "x" } }))).not.toThrow();
  });

  it("rejects inline secret values, naming the key", () => {
    expect(() => validateGateConfig(cfg({ type: "client_credentials", issuer: "https://as.example", clientId: "c", clientSecret: "hunter2" }))).toThrow(
      /"clientSecret".*inline secret string.*\{ env: "NAME" \}/s,
    );
    const e = { type: "enterprise", issuer: "https://as.example", clientId: "c", idp: { tokenEndpoint: "https://idp.example/token", clientId: "i" } };
    expect(() => validateGateConfig(cfg({ ...e, idToken: "eyJ.inline.jwt" }))).toThrow(/"idToken".*inline secret/s);
    expect(() => validateGateConfig(cfg({ ...e, idToken: { env: "T" }, idp: { ...e.idp, clientSecret: "inline" } }))).toThrow(/"clientSecret".*idp.*inline secret|inline secret.*idp/s);
    expect(() => validateGateConfig(cfg({ ...e, idToken: { env: "T" }, clientSecret: "inline" }))).toThrow(/inline secret/);
  });

  it("does not echo the offending secret value in the error", () => {
    try {
      validateGateConfig(cfg({ type: "client_credentials", issuer: "https://as.example", clientId: "c", clientSecret: "hunter2-very-secret" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(String(e)).not.toContain("hunter2-very-secret");
    }
  });

  it("requires issuer, a known type, and a single auth mechanism", () => {
    expect(() => validateGateConfig(cfg({ type: "client_credentials", clientId: "c", clientSecret: { env: "X" } }))).toThrow(/"issuer" is required/);
    expect(() => validateGateConfig(cfg({ type: "basic" }))).toThrow(/"type".*client_credentials.*enterprise/);
    expect(() =>
      validateGateConfig({ upstreams: { up: { url: "https://e.com/mcp", getToken: () => "x", auth: { type: "client_credentials", issuer: "i", clientId: "c", clientSecret: { env: "X" } } } as never } }),
    ).toThrow(/both "auth" and "getToken"/);
    expect(() =>
      validateGateConfig({ upstreams: { up: { url: "https://e.com/mcp", headers: { authorization: "Bearer x" }, auth: { type: "client_credentials", issuer: "i", clientId: "c", clientSecret: { env: "X" } } } as never } }),
    ).toThrow(/both "headers\.Authorization" and "auth"/);
  });

  it("rejects unknown keys inside auth", () => {
    expect(() => validateGateConfig(cfg({ type: "client_credentials", issuer: "i", clientId: "c", clientSecret: { env: "X" }, secret: "x" }))).toThrow(/unknown key "secret"/);
  });
});

describe("token cache", () => {
  it("serves from cache until shortly before expiry, then refetches", async () => {
    let t = 1_000_000;
    let n = 0;
    const src = cachedTokenSource(async () => ({ access_token: `t${++n}`, expires_in: 100 }), () => t);
    expect(await src.token()).toBe("t1");
    t += 60_000;
    expect(await src.token()).toBe("t1"); // 60s of 100s elapsed: still fresh
    t += 15_000; // 75s: inside the 30s skew window
    expect(await src.token()).toBe("t2");
    expect(n).toBe(2);
  });

  it("shares one in-flight fetch between concurrent callers and forgets on invalidate", async () => {
    let n = 0;
    const src = cachedTokenSource(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { access_token: `t${++n}`, expires_in: 3600 };
    });
    expect(await Promise.all([src.token(), src.token(), src.token()])).toEqual(["t1", "t1", "t1"]);
    src.invalidate();
    expect(await src.token()).toBe("t2");
  });

  it("does not cache a failure", async () => {
    let n = 0;
    const src = cachedTokenSource(async () => {
      if (++n === 1) throw new Error("boom");
      return { access_token: "ok", expires_in: 60 };
    });
    await expect(src.token()).rejects.toThrow("boom");
    expect(await src.token()).toBe("ok");
  });
});

describe("client_credentials against a mock authorization server", () => {
  it("fetches a token with client_secret_basic, resource and scope, then caches it", async () => {
    const src = tokenSourceFor(mock.mcpUrl, cc({ scope: "mcp:read" }));
    expect(await src.token()).toBe("cc-1");
    expect(await src.token()).toBe("cc-1");
    expect(mock.asHits).toHaveLength(1);
    expect(mock.asHits[0]!.body.get("grant_type")).toBe("client_credentials");
    expect(mock.asHits[0]!.body.get("resource")).toBe(mock.mcpUrl);
    expect(mock.asHits[0]!.body.get("scope")).toBe("mcp:read");
    expect(mock.asHits[0]!.body.get("client_secret")).toBeNull(); // not in the body: basic auth only
  });

  it("refreshes after expiry (injected clock) and after invalidate()", async () => {
    mock.setExpiresIn(60);
    let t = 5_000_000;
    const src = tokenSourceFor(mock.mcpUrl, cc(), () => t);
    expect(await src.token()).toBe("cc-1");
    t += 40_000; // past expires_in minus 30s skew
    expect(await src.token()).toBe("cc-2");
    src.invalidate();
    expect(await src.token()).toBe("cc-3");
    expect(mock.asHits).toHaveLength(3);
  });

  it("refuses to send credentials when the discovered issuer is not the configured one", async () => {
    const src = tokenSourceFor(mock.mcpUrl, cc({ issuer: "https://some-other-as.example" }));
    await expect(src.token()).rejects.toThrow(/issuer mismatch/);
    expect(mock.asHits).toHaveLength(0);
  });

  it("surfaces an OAuth error without leaking the secret", async () => {
    process.env.GATE_TEST_CC_SECRET = "wrong-secret-value-123";
    const src = tokenSourceFor(mock.mcpUrl, cc());
    const err = await src.token().catch((e) => e as Error);
    expect(String(err)).toMatch(/invalid_client/);
    expect(String(err)).not.toContain("wrong-secret-value-123");
  });

  it("names the env var when the secret is not set", async () => {
    delete process.env.GATE_TEST_CC_SECRET;
    await expect(tokenSourceFor(mock.mcpUrl, cc()).token()).rejects.toThrow(/GATE_TEST_CC_SECRET is not set/);
  });

  it("works with a callback secret and an explicit tokenEndpoint (no discovery)", async () => {
    const src = tokenSourceFor("https://unreachable.invalid/mcp", cc({ clientSecret: { get: async () => CC.clientSecret }, tokenEndpoint: mock.asTokenEndpoint }));
    expect(await src.token()).toBe("cc-1");
  });
});

describe("enterprise-managed authorization (MOCK IdP only; untested against a real one)", () => {
  it("exchanges the ID token for an ID-JAG at the IdP, then the ID-JAG for an access token at the AS", async () => {
    const src = tokenSourceFor(mock.mcpUrl, ent({ scope: "mcp:read" }));
    expect(await src.token()).toBe("ent-1");
    const idp = mock.idpHits[0]!.body;
    expect(idp.get("audience")).toBe(mock.issuer);
    expect(idp.get("resource")).toBe(mock.mcpUrl);
    expect(idp.get("scope")).toBe("mcp:read");
    const as = mock.asHits[0]!.body;
    expect(as.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(as.get("assertion")).toBe("ID-JAG-1");
    expect(await src.token()).toBe("ent-1"); // cached
    expect(mock.idpHits).toHaveLength(1);
  });

  it("surfaces an IdP denial without the ID token or secrets in the message", async () => {
    process.env.GATE_TEST_ID_TOKEN = "revoked-id-token-xyz";
    const err = await tokenSourceFor(mock.mcpUrl, ent()).token().catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("revoked-id-token-xyz");
    expect(String(err)).not.toContain(ENT.idpSecret);
    expect(mock.asHits).toHaveLength(0);
  });
});

describe("a gate with an OAuth upstream, end to end", () => {
  it.each([
    ["client_credentials", () => cc(), /^Bearer cc-1$/],
    ["enterprise", () => ent(), /^Bearer ent-1$/],
  ])("%s: calls through the gate with a cached token; no secret or token reaches the audit log", async (_n, auth, bearer) => {
    const audit: unknown[] = [];
    const gate = await createGate({
      upstreams: { prot: { url: mock.mcpUrl, auth: auth() } },
      audit: (e) => audit.push(e),
    });
    const r1 = (await gate.client.callTool("prot.whoami", {})) as { content: { text: string }[] };
    const r2 = (await gate.client.callTool("prot.whoami", {})) as { content: { text: string }[] };
    expect(r1.content[0]!.text).toBe("hello");
    expect(r2.content[0]!.text).toBe("hello");
    const seen = new Set(mock.mcpAuth.filter(Boolean));
    expect([...seen].every((a) => bearer.test(a!))).toBe(true);
    expect(mock.asHits).toHaveLength(1); // one token fetch for every request
    await gate.close();
    const dump = JSON.stringify(audit);
    for (const secret of [CC.clientSecret, ENT.idToken, ENT.idpSecret, ENT.asSecret, "cc-1", "ent-1", "ID-JAG-1"]) expect(dump).not.toContain(secret);
    expect(audit.length).toBeGreaterThan(0);
  });
});
