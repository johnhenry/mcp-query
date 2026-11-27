// #85: the gate publishes a Server Card for its own endpoint; it never describes the upstreams unless asked.
import { describe, expect, it } from "vitest";
import { compareCardToLive, fetchServerCard, parseServerCard } from "@johnhenry/mcp-query/discovery";
import { createGateCardHandler, gateCardUrl, gateServerCard, GATE_CARD_META_KEY } from "../src/index.js";
import { validateGateConfig } from "../src/validate.js";
import type { GateConfig } from "../src/config.js";

const config: GateConfig = {
  upstreams: {
    "payroll-secret": { url: "https://internal.corp.example/mcp-payroll", headers: { authorization: "Bearer s3cret" } },
    "hr-notes": { command: "hr-notes-mcp", args: ["--db", "/srv/hr.db"] },
  },
  card: { url: "https://gate.example.com/mcp", name: "com.example/gate", version: "1.2.3" },
};

describe("gateServerCard", () => {
  it("validates against the Server Card schema", () => {
    const card = gateServerCard(config);
    const parsed = parseServerCard(card);
    expect(parsed.name).toBe("com.example/gate");
    expect(parsed.remotes?.[0]).toMatchObject({ type: "streamable-http", url: "https://gate.example.com/mcp" });
    expect(parsed.remotes?.[0]?.supportedProtocolVersions?.length).toBeGreaterThan(0);
  });

  it("default card contains no upstream name, URL, command, secret or count", () => {
    const json = JSON.stringify(gateServerCard(config));
    for (const leak of ["payroll-secret", "hr-notes", "internal.corp", "hr-notes-mcp", "s3cret", "hr.db", "upstream", GATE_CARD_META_KEY]) {
      expect(json).not.toContain(leak);
    }
    expect(gateServerCard(config)._meta).toBeUndefined();
  });

  it("lists upstream NAMES only with listUpstreams: true, never URLs or commands", () => {
    const card = gateServerCard({ ...config, card: { ...config.card!, listUpstreams: true } });
    expect(card._meta).toEqual({ [GATE_CARD_META_KEY]: { upstreams: ["payroll-secret", "hr-notes"] } });
    const json = JSON.stringify(card);
    for (const leak of ["internal.corp", "hr-notes-mcp", "s3cret", "hr.db"]) expect(json).not.toContain(leak);
    parseServerCard(card);
  });

  it("honours overrides and explicit protocol versions, and drops query/hash from the URL", () => {
    const card = gateServerCard(config, { url: "https://g.example/x/mcp?token=abc#frag", supportedProtocolVersions: ["2026-07-28"], description: "d", title: "T" });
    expect(card.remotes[0]).toEqual({ type: "streamable-http", url: "https://g.example/x/mcp", supportedProtocolVersions: ["2026-07-28"] });
    expect(card.title).toBe("T");
  });

  it("rejects a card that would not validate", () => {
    expect(() => gateServerCard({ upstreams: {} })).toThrow(/card\.url/);
    expect(() => gateServerCard(config, { name: "no-slash" })).toThrow(/reverse-DNS/);
    expect(() => gateServerCard(config, { url: "ftp://x" })).toThrow(/http/);
    expect(() => gateServerCard(config, { url: "https://u:p@x.example/mcp" })).toThrow(/credentials/);
    expect(() => gateServerCard(config, { description: "x".repeat(101) })).toThrow(/1-100/);
    expect(() => gateServerCard(config, { url: "not a url" })).toThrow(/valid URL/);
    expect(() => gateServerCard({ ...config, card: { ...config.card!, version: undefined as unknown as string } })).toThrow(/version/);
  });

  it("gateCardUrl follows the SEP location", () => {
    expect(gateCardUrl("https://gate.example.com/mcp/?a=1")).toBe("https://gate.example.com/mcp/server-card");
  });
});

describe("createGateCardHandler", () => {
  const handle = createGateCardHandler(config);
  const req = (path: string, init?: RequestInit) => new Request(`https://gate.example.com${path}`, init);

  it("serves the card at <endpoint>/server-card with the card media type and CORS", async () => {
    const res = handle(req("/mcp/server-card"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(parseServerCard(await res.json()).name).toBe("com.example/gate");
  });

  it("falls through for other paths so the MCP handler can take them", () => {
    expect(handle(req("/mcp"))).toBeUndefined();
    expect(handle(req("/other/server-card"))).toBeUndefined();
  });

  it("HEAD has no body; OPTIONS answers the preflight; POST is 405", async () => {
    const head = handle(req("/mcp/server-card", { method: "HEAD" }))!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(handle(req("/mcp/server-card", { method: "OPTIONS" }))!.status).toBe(204);
    const post = handle(req("/mcp/server-card", { method: "POST" }))!;
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toContain("GET");
  });

  it("is fetchable by mcp-query's own discovery client and agrees with itself", async () => {
    const f = (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(input as string, init)) ?? new Response("nope", { status: 404 })) as typeof fetch;
    const { card, url } = await fetchServerCard(gateCardUrl("https://gate.example.com/mcp"), { fetch: f });
    expect(url).toBe("https://gate.example.com/mcp/server-card");
    const versions = card.remotes![0]!.supportedProtocolVersions!;
    expect(compareCardToLive(card, { connectedUrl: "https://gate.example.com/mcp", negotiatedVersion: versions[0], supportedVersions: versions }).filter((x) => x.kind === "differs")).toEqual([]);
  });
});

describe("GateConfig.card validation", () => {
  it("accepts a valid card block and rejects typos", () => {
    expect(() => validateGateConfig(config)).not.toThrow();
    expect(() => validateGateConfig({ ...config, card: { ...config.card, listUpstream: true } })).toThrow(/unknown key "listUpstream"/);
    expect(() => validateGateConfig({ ...config, card: { name: "a/b", version: "1" } })).toThrow(/"url" in card is required/);
    expect(() => validateGateConfig({ ...config, card: { ...config.card, listUpstreams: "yes" } })).toThrow(/listUpstreams/);
  });
});
