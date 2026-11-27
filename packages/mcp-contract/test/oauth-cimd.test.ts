import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileOAuthProvider, authenticate, tokenCachePath } from "../src/oauth.js";
import {
  DEFAULT_CLIENT_METADATA_URL,
  DEFAULT_CLIENT_METADATA_REDIRECT_URIS,
  isValidClientMetadataUrl,
  resolveClientMetadataUrl,
} from "../src/clientMetadata.js";
import { dpopSupported, loadOrCreateDpopSession, assertDpopSupported, dpopKeyPath } from "../src/dpop.js";
import { startMockAs, type MockAs, type MockAsOptions } from "./helpers/mockAs.js";

const CIMD = "https://client.example.test/oauth/client.json";
const here = dirname(fileURLToPath(import.meta.url));

let home: string;
let realHome: string | undefined;
let mock: MockAs | undefined;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "mcpq-home-"));
  process.env.HOME = home;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  process.env.HOME = realHome;
  errSpy.mockRestore();
  await mock?.close();
  mock = undefined;
});

/** Run authenticate() and play the browser: follow the printed authorize URL to the callback. */
async function login(opts: MockAsOptions, extra: Parameters<typeof authenticate>[1] = {}) {
  mock = await startMockAs(opts);
  let finished = false;
  const done = authenticate(mock.mcpUrl, { open: false, port: 0, timeoutMs: 5000, ...extra }).finally(() => (finished = true));
  // authenticate() prints the authorize URL; fetch it like a browser would.
  const browser = (async () => {
    for (let i = 0; i < 200 && !finished; i++) {
      const line = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => /\/authorize\?/.test(l));
      if (line) {
        const authUrl = line.match(/https?:\/\/\S+\/authorize\?\S+/)![0];
        const r = await fetch(authUrl, { redirect: "manual" });
        await fetch(r.headers.get("location")!);
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  const [tokens] = await Promise.allSettled([done, browser]).then(([a]) => [a] as const);
  return tokens;
}

describe("CIMD preferred, DCR fallback", () => {
  it("uses the Client ID Metadata Document URL as client_id when the AS advertises support (no registration)", async () => {
    const r = await login({ cimd: true }, { clientMetadataUrl: CIMD });
    expect(r.status).toBe("fulfilled");
    expect(mock!.rec.registrations).toHaveLength(0);
    expect(mock!.rec.authorizeQueries[0]!.get("client_id")).toBe(CIMD);
    expect(mock!.rec.tokenRequests[0]!.body.get("client_id")).toBe(CIMD);
    const cache = JSON.parse(readFileSync(tokenCachePath(mock!.mcpUrl), "utf8"));
    expect(cache.byIssuer[mock!.issuer].clientInformation.client_id).toBe(CIMD);
  });

  it("falls back to dynamic client registration when the AS does not advertise CIMD", async () => {
    const r = await login({ cimd: false }, { clientMetadataUrl: CIMD });
    expect(r.status).toBe("fulfilled");
    expect(mock!.rec.registrations).toHaveLength(1);
    expect(mock!.rec.registrations[0]).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none" });
    expect(mock!.rec.authorizeQueries[0]!.get("client_id")).toBe("dcr-client-1");
  });

  it("registers dynamically when CIMD is switched off, even if the AS supports it", async () => {
    const r = await login({ cimd: true }, { clientMetadataUrl: false });
    expect(r.status).toBe("fulfilled");
    expect(mock!.rec.registrations).toHaveLength(1);
  });

  it("reports which mechanism produced the stored client", () => {
    const p = new FileOAuthProvider(join(home, "c.json"), { clientMetadataUrl: CIMD, interactive: true });
    p.saveClientInformation({ client_id: CIMD } as never, { issuer: "https://as.example" });
    p.saveClientInformation({ client_id: "abc" } as never, { issuer: "https://other.example" });
    expect(p.registrationMethod("https://as.example")).toBe("cimd");
    expect(p.registrationMethod("https://other.example")).toBe("dcr");
    expect(p.registrationMethod("https://unknown.example")).toBeUndefined();
  });
});

describe("issuer validation (RFC 9207)", () => {
  it("rejects an authorization response whose iss is not the recorded issuer, before redeeming the code", async () => {
    const r = await login({ cimd: true, issOnRedirect: "https://evil.example" }, { clientMetadataUrl: CIMD });
    expect(r.status).toBe("rejected");
    expect(String((r as PromiseRejectedResult).reason)).toMatch(/iss|issuer/i);
    expect(mock!.rec.tokenRequests).toHaveLength(0);
  });

  it("rejects a missing iss when the AS advertises authorization_response_iss_parameter_supported", async () => {
    const r = await login({ cimd: true, issOnRedirect: null, issSupported: true }, { clientMetadataUrl: CIMD });
    expect(r.status).toBe("rejected");
    expect(mock!.rec.tokenRequests).toHaveLength(0);
  });

  it("accepts a missing iss when the AS does not advertise it (RFC 9207 table row 4)", async () => {
    const r = await login({ cimd: true, issOnRedirect: null, issSupported: false }, { clientMetadataUrl: CIMD });
    expect(r.status).toBe("fulfilled");
  });

  it("expectedIssuer pins the authorization server: a different discovered issuer is refused before registration", async () => {
    const r = await login({ cimd: false }, { clientMetadataUrl: CIMD, expectedIssuer: "https://the-real-as.example" });
    expect(r.status).toBe("rejected");
    expect(String((r as PromiseRejectedResult).reason)).toMatch(/issuer mismatch/);
    expect(mock!.rec.registrations).toHaveLength(0);
  });

  it("expectedIssuer equal to the discovered issuer is accepted; a different one throws", () => {
    const p = new FileOAuthProvider(join(home, "e.json"), { expectedIssuer: "https://as.example" });
    const state = (issuer: string) => ({ authorizationServerUrl: issuer, authorizationServerMetadata: { issuer } }) as never;
    expect(() => p.saveDiscoveryState(state("https://as.example"))).not.toThrow();
    expect(() => p.saveDiscoveryState(state("https://other.example"))).toThrow(/issuer mismatch/);
    expect(p.discoveryState()).toMatchObject({ authorizationServerUrl: "https://as.example" });
  });
});

describe("issuer-keyed storage", () => {
  it("never hands one issuer's registration or tokens to another", () => {
    const p = new FileOAuthProvider(join(home, "k.json"), { interactive: true });
    p.saveClientInformation({ client_id: "a" } as never, { issuer: "https://as-a.example" });
    p.saveTokens({ access_token: "tok-a", token_type: "Bearer" } as never, { issuer: "https://as-a.example" });
    expect(p.clientInformation({ issuer: "https://as-b.example" })).toBeUndefined();
    expect(p.tokens({ issuer: "https://as-b.example" })).toBeUndefined();
    expect(p.clientInformation({ issuer: "https://as-a.example" })?.client_id).toBe("a");
  });

  it("ignores a legacy flat cache for any explicit issuer and survives a corrupt file", () => {
    const file = join(home, "legacy.json");
    writeFileSync(file, JSON.stringify({ clientInformation: { client_id: "old" }, tokens: { access_token: "old-tok", token_type: "Bearer" } }));
    const p = new FileOAuthProvider(file);
    expect(p.clientInformation({ issuer: "https://as.example" })).toBeUndefined();
    expect(p.tokens({ issuer: "https://as.example" })).toBeUndefined();

    const bad = join(home, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => new FileOAuthProvider(bad)).not.toThrow();
    expect(new FileOAuthProvider(bad).tokens()).toBeUndefined();
  });

  it("writes the cache owner-only (0600)", () => {
    const file = join(home, "sub", "perm.json");
    const p = new FileOAuthProvider(file, { interactive: true });
    p.saveTokens({ access_token: "x", token_type: "Bearer" } as never, { issuer: "https://as.example" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("client metadata URL", () => {
  it("the checked-in document's client_id equals the constant and lists the default loopback redirects", () => {
    const doc = JSON.parse(readFileSync(join(here, "../../../oauth/client-metadata.json"), "utf8"));
    expect(doc.client_id).toBe(DEFAULT_CLIENT_METADATA_URL);
    expect(doc.redirect_uris).toEqual([...DEFAULT_CLIENT_METADATA_REDIRECT_URIS]);
    expect(doc).toMatchObject({ client_name: expect.any(String), token_endpoint_auth_method: "none" });
    expect(isValidClientMetadataUrl(doc.client_id)).toBe(true);
    // Served by GitHub Pages (application/json), not raw.githubusercontent.com (text/plain).
    expect(new URL(doc.client_id).host).toBe("johnhenry.github.io");
  });

  it("resolves flag > env > default, and `off` disables", () => {
    expect(resolveClientMetadataUrl(undefined, {})).toBe(DEFAULT_CLIENT_METADATA_URL);
    expect(resolveClientMetadataUrl(undefined, { MCPQ_CLIENT_METADATA_URL: "https://x.example/c.json" })).toBe("https://x.example/c.json");
    expect(resolveClientMetadataUrl("https://flag.example/c.json", { MCPQ_CLIENT_METADATA_URL: "https://x.example/c.json" })).toBe("https://flag.example/c.json");
    expect(resolveClientMetadataUrl("off", {})).toBeUndefined();
    expect(resolveClientMetadataUrl(false, {})).toBeUndefined();
    expect(resolveClientMetadataUrl(undefined, { MCPQ_CLIENT_METADATA_URL: "off" })).toBeUndefined();
    expect(() => resolveClientMetadataUrl("http://insecure.example/c.json", {})).toThrow(/https/);
    expect(() => resolveClientMetadataUrl("https://root.example/", {})).toThrow(/path/);
  });

  it("offers the default document only when this run's redirect URL is one the document lists", () => {
    const listed = new FileOAuthProvider(join(home, "a.json"), { redirectUrl: DEFAULT_CLIENT_METADATA_REDIRECT_URIS[0] });
    expect(listed.clientMetadataUrl).toBe(DEFAULT_CLIENT_METADATA_URL);
    const other = new FileOAuthProvider(join(home, "b.json"), { redirectUrl: "http://localhost:51234/callback" });
    expect(other.clientMetadataUrl).toBeUndefined(); // would not match the document: use DCR
  });
});

describe("DPoP (opt-in, SDK >= 2.1.0)", () => {
  it("fails with a clear message on an SDK without DPoP", () => {
    if (dpopSupported()) return;
    expect(() => new FileOAuthProvider(join(home, "d.json"), { dpop: true })).toThrow(/needs @modelcontextprotocol\/client >= 2\.1\.0/);
  });

  it("assertDpopSupported names the minimum version", () => {
    expect(() => assertDpopSupported({})).toThrow(/2\.1\.0/);
  });

  it("persists the key with mode 0600 and reloads the same identity (fake SDK surface)", async () => {
    const fake = {
      generateDpopKeyPair: async () => {
        const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
        const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
        return { privateKey: kp.privateKey, publicKey: kp.publicKey, publicJwk, thumbprint: "thumb-abc", alg: "ES256" };
      },
      DpopSession: { create: async (o?: { keyPair?: { thumbprint: string; alg: string } }) => ({ thumbprint: o!.keyPair!.thumbprint, alg: o!.keyPair!.alg }) },
    };
    const keyFile = join(home, "keys", "k.dpop-key.json");
    const s1 = await loadOrCreateDpopSession(keyFile, fake);
    expect(s1.thumbprint).toBe("thumb-abc");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);
    const before = readFileSync(keyFile, "utf8");
    const s2 = await loadOrCreateDpopSession(keyFile, fake);
    expect(s2.thumbprint).toBe("thumb-abc");
    expect(readFileSync(keyFile, "utf8")).toBe(before); // reused, not regenerated
    expect(dpopKeyPath("/x/y/host.json")).toBe("/x/y/host.dpop-key.json");
  });

  it.skipIf(!dpopSupported())("sends a valid DPoP proof on the token request and stores a 0600 key", async () => {
    const r = await login({ cimd: true }, { clientMetadataUrl: CIMD, dpop: true });
    expect(r.status).toBe("fulfilled");
    const tr = mock!.rec.tokenRequests[0]!;
    expect(tr.dpop?.valid).toBe(true);
    expect(tr.dpop?.htm).toBe("POST");
    const keyFile = dpopKeyPath(tokenCachePath(mock!.mcpUrl));
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    // The private key must not leak into the printed output or the token cache.
    const d = JSON.parse(readFileSync(keyFile, "utf8")).privateJwk.d as string;
    expect(errSpy.mock.calls.flat().join("\n")).not.toContain(d);
    expect(readFileSync(tokenCachePath(mock!.mcpUrl), "utf8")).not.toContain(d);
  });

  it("no DPoP header when not enabled", async () => {
    const r = await login({ cimd: true }, { clientMetadataUrl: CIMD });
    expect(r.status).toBe("fulfilled");
    expect(mock!.rec.tokenRequests[0]!.headers.dpop).toBeUndefined();
  });
});
void mkdirSync;
