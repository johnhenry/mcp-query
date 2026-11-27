// @vitest-environment node
// The browser provider against an in-process mock authorization server (CIMD-capable and DCR-only),
// driven through the SDK's real transport, plus the stepper's summary of what was recorded.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { instrumentAuthProvider, type AuthStep } from "@johnhenry/mcp-query";
import { createInstrumentedProvider, INSPECTOR_CLIENT_METADATA_URL, isValidClientMetadataUrl, resolveClientMetadataUrl, type InstrumentedBrowserProvider } from "../src/lib/oauth.js";
import { completeAuth } from "../src/lib/oauthResume.js";
import { summarizeAuth, labelFor } from "../src/lib/oauthSteps.js";
import { startMockAs, type MockAs, type MockAsOptions } from "./helpers/mockAs.js";

const here = dirname(fileURLToPath(import.meta.url));
const CIMD = "https://client.example.test/inspector-client-metadata.json";
const ORIGIN = "http://localhost:5173";
const goodDoc = { client_id: CIMD, redirect_uris: [`${ORIGIN}/`, "http://127.0.0.1:5173/"] };

/** A fetch that serves the metadata document (or fails), standing in for the browser reaching GitHub Pages. */
const docFetch = (doc: unknown | "unreachable" | number): typeof fetch =>
  (async () => {
    if (doc === "unreachable") throw new TypeError("Failed to fetch");
    if (typeof doc === "number") return new Response("nope", { status: doc });
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

// A tiny browser: sessionStorage + location, so the provider runs unchanged in node.
let store: Map<string, string>;
let navigatedTo: string | undefined;
beforeEach(() => {
  store = new Map();
  navigatedTo = undefined;
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  // Object.keys(sessionStorage) is how the provider enumerates; mirror Web Storage by exposing keys as own props.
  const proxy = new Proxy(storage, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (_t, k) => (store.has(String(k)) ? { enumerable: true, configurable: true, value: store.get(String(k)) } : undefined) });
  Object.assign(globalThis, {
    sessionStorage: proxy,
    location: { origin: ORIGIN, pathname: "/", get href() { return navigatedTo ?? ""; }, set href(v: string) { navigatedTo = v; } },
  });
});

let mock: MockAs | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

/** Leg 1: connect, get sent to the authorization endpoint. Leg 2: "reload", follow the redirect back, finish. */
async function login(asOpts: MockAsOptions, provOpts: { fetch?: typeof fetch; clientMetadataUrl?: string | false } = {}) {
  mock = await startMockAs(asOpts);
  const steps: AuthStep[] = [];
  const mk = () => createInstrumentedProvider("srv", (s) => steps.push(s), { fetch: docFetch(goodDoc), clientMetadataUrl: CIMD, ...provOpts });

  const p1 = mk();
  await p1.prepare();
  const client = new Client({ name: "t", version: "0" });
  await expect(client.connect(new StreamableHTTPClientTransport(new URL(mock.mcpUrl), { authProvider: p1 }))).rejects.toThrow();
  expect(navigatedTo).toMatch(/\/authorize\?/);

  // The browser follows the authorization URL; the AS redirects back to the page with ?code=&iss=.
  const r = await fetch(navigatedTo!, { redirect: "manual" });
  const back = new URL(r.headers.get("location")!);

  // New page load = new provider instance over the same sessionStorage.
  const p2 = mk();
  await p2.prepare(); // as resumeIfAuthCallback does
  const t2 = new StreamableHTTPClientTransport(new URL(mock.mcpUrl), { authProvider: p2 });
  let error: unknown;
  try {
    await completeAuth(t2 as never, p2, back.searchParams);
  } catch (e) {
    error = e;
  }
  return { steps, p2, error, view: summarizeAuth(steps) };
}

describe("registration: CIMD preferred, DCR fallback", () => {
  it("CIMD-capable AS + reachable document: the document URL is the client_id and nothing is registered", async () => {
    const r = await login({ cimd: true });
    expect(r.error).toBeUndefined();
    expect(mock!.rec.registrations).toHaveLength(0);
    expect(mock!.rec.authorizeQueries[0]!.get("client_id")).toBe(CIMD);
    expect(mock!.rec.tokenRequests[0]!.body.get("client_id")).toBe(CIMD);
    expect(r.view.registration).toMatchObject({ method: "cimd", clientId: CIMD, offers: { cimd: true, dcr: true } });
    expect(r.view.registration.why).toMatch(/Client ID Metadata Document/);
    expect(r.p2.tokens()).toBeTruthy();
  });

  it("DCR-only AS: registers dynamically and says the server does not advertise CIMD", async () => {
    const r = await login({ cimd: false });
    expect(r.error).toBeUndefined();
    expect(mock!.rec.registrations).toHaveLength(1);
    expect(mock!.rec.registrations[0]).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none" });
    expect(mock!.rec.authorizeQueries[0]!.get("client_id")).toBe("dcr-client-1");
    expect(r.view.registration).toMatchObject({ method: "dcr", offers: { cimd: false, dcr: true } });
    expect(r.view.registration.why).toMatch(/does not advertise Client ID Metadata Document support/);
  });

  it.each([
    ["unreachable", docFetch("unreachable"), /not reachable/],
    ["HTTP 404", docFetch(404), /HTTP 404/],
    ["client_id is not its own URL", docFetch({ ...goodDoc, client_id: "https://other.example/x.json" }), /not its own URL/],
    ["redirect URI not listed", docFetch({ ...goodDoc, redirect_uris: ["http://localhost:9999/"] }), /does not list this page's redirect URI/],
  ])("CIMD-capable AS but document %s: falls back to DCR and records why", async (_n, f, why) => {
    const r = await login({ cimd: true }, { fetch: f });
    expect(r.error).toBeUndefined();
    expect(mock!.rec.registrations).toHaveLength(1);
    expect(r.view.registration.method).toBe("dcr");
    expect(r.view.registration.why).toMatch(why);
  });

  it("CIMD switched off: DCR, and the stepper says so", async () => {
    const r = await login({ cimd: true }, { clientMetadataUrl: false });
    expect(mock!.rec.registrations).toHaveLength(1);
    expect(r.view.registration.why).toMatch(/switched off/);
  });
});

describe("issuer validation (RFC 9207)", () => {
  it("passes when iss matches the issuer recorded at discovery, with expected = received", async () => {
    const r = await login({ cimd: true });
    expect(r.view.issuer).toMatchObject({ result: "passed", expected: mock!.issuer, received: mock!.issuer });
  });

  it("rejects a wrong iss before redeeming the code and shows expected vs received", async () => {
    const r = await login({ cimd: true, issOnRedirect: "https://evil.example" });
    expect(r.error).toBeTruthy();
    expect(mock!.rec.tokenRequests).toHaveLength(0);
    expect(r.p2.tokens()).toBeUndefined();
    expect(r.view.issuer).toMatchObject({ result: "failed", expected: mock!.issuer, received: "https://evil.example" });
  });

  it("rejects a missing iss when the AS says it sends one", async () => {
    const r = await login({ cimd: false, issOnRedirect: null, issSupported: true });
    expect(r.error).toBeTruthy();
    expect(mock!.rec.tokenRequests).toHaveLength(0);
    expect(r.view.issuer.result).toBe("failed");
    expect(r.view.issuer.received).toMatch(/no iss/);
  });
});

describe("what the stepper records never contains a secret", () => {
  it("has no token, verifier or refresh token anywhere in the step log", async () => {
    const r = await login({ cimd: true });
    const log = JSON.stringify(r.steps);
    expect(log).not.toContain("at-1");
    expect(log).not.toContain("rt-1");
    expect(log).not.toContain(store.get("mcp-oauth:srv:verifier")!);
    expect(log).toMatch(/hasAccessToken/);
    expect(labelFor("srv.saveTokens")).toMatch(/values hidden/);
  });
});

describe("DPoP in the summary", () => {
  it("is off with no dpop step", () => {
    expect(summarizeAuth([]).dpop).toMatchObject({ enabled: false });
  });
  it("is on with only the key thumbprint shown (never the key)", async () => {
    const inner = { dpop: async () => ({ thumbprint: "jkt-123", alg: "ES256", privateKey: "PRIVATE-KEY-MATERIAL" }) };
    const steps: AuthStep[] = [];
    await instrumentAuthProvider(inner, (s) => steps.push(s)).dpop();
    expect(JSON.stringify(steps)).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(summarizeAuth(steps).dpop).toMatchObject({ enabled: true, thumbprint: "jkt-123", alg: "ES256" });
  });
});

describe("the inspector's client metadata document", () => {
  const doc = JSON.parse(readFileSync(join(here, "../../../oauth/inspector-client-metadata.json"), "utf8"));
  it("client_id is its own public URL (the constant), on GitHub Pages, not the CLI's document", () => {
    expect(doc.client_id).toBe(INSPECTOR_CLIENT_METADATA_URL);
    expect(isValidClientMetadataUrl(doc.client_id)).toBe(true);
    expect(new URL(doc.client_id).host).toBe("johnhenry.github.io");
    const cli = JSON.parse(readFileSync(join(here, "../../../oauth/client-metadata.json"), "utf8"));
    expect(doc.client_id).not.toBe(cli.client_id);
  });
  it("is a public client with the dev server's redirect URIs", () => {
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.redirect_uris).toEqual(["http://localhost:5173/", "http://127.0.0.1:5173/"]);
    expect(doc.client_secret).toBeUndefined();
    expect(doc.response_types).toEqual(["code"]);
  });
  it("matches what the provider computes as its redirect URL under the dev origin", () => {
    // location.origin + pathname, as the dev server serves the app at the root.
    expect(doc.redirect_uris).toContain(`${ORIGIN}/`);
  });
  it("URL resolution: explicit > env > constant; off disables; non-https throws", () => {
    expect(resolveClientMetadataUrl()).toBe(INSPECTOR_CLIENT_METADATA_URL);
    expect(resolveClientMetadataUrl(undefined, "https://x.example/c.json")).toBe("https://x.example/c.json");
    expect(resolveClientMetadataUrl("https://flag.example/c.json", "https://x.example/c.json")).toBe("https://flag.example/c.json");
    expect(resolveClientMetadataUrl("off")).toBeUndefined();
    expect(resolveClientMetadataUrl(false)).toBeUndefined();
    expect(() => resolveClientMetadataUrl("http://insecure.example/c.json")).toThrow(/https/);
  });
});

// Keep the type used (documents the instrumented provider's surface).
export type _P = InstrumentedBrowserProvider;
