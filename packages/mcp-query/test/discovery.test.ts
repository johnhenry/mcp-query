import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DiscoveryError,
  compareCardToLive,
  connectableRemoteUrl,
  discoverFromDomain,
  fetchServerCard,
  normalizeDomain,
  recommendedCardUrl,
  resolveRemote,
  sanitizeForDisplay,
  selectRemote,
  type ServerCard,
} from "../src/discovery/index.js";

const SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
const card = (over: Record<string, unknown> = {}) => ({
  $schema: SCHEMA,
  name: "example-org/weather",
  version: "1.2.3",
  description: "Weather lookups.",
  remotes: [{ type: "streamable-http", url: "http://127.0.0.1:1/mcp", supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }],
  ...over,
});

let server: Server;
let base: string;
let hits: Record<string, number> = {};
let other: Server; // a second origin for cross-origin redirect/catalog tests
let otherBase: string;

function send(res: import("node:http").ServerResponse, status: number, type: string | undefined, body: string | Buffer, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...(type ? { "content-type": type } : {}), ...extra });
  res.end(body);
}

beforeAll(async () => {
  other = createServer((req, res) => {
    hits["other" + req.url] = (hits["other" + req.url] ?? 0) + 1;
    if (req.url === "/card") return send(res, 200, "application/mcp-server-card+json", JSON.stringify(card({ name: "other-org/elsewhere" })));
    send(res, 404, "text/plain", "no");
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  server = createServer((req, res) => {
    const url = req.url ?? "/";
    hits[url] = (hits[url] ?? 0) + 1;
    switch (url) {
      case "/card":
        return send(res, 200, "application/mcp-server-card+json; charset=utf-8", JSON.stringify(card()), { etag: '"v1"' });
      case "/card-json":
        return send(res, 200, "application/json", JSON.stringify(card()));
      case "/mcp/server-card":
        return send(res, 200, "application/mcp-server-card+json", JSON.stringify(card()));
      case "/huge":
        return send(res, 200, "application/mcp-server-card+json", "x".repeat(10_000));
      case "/huge-stream": {
        // no Content-Length: chunked, bigger than the cap
        res.writeHead(200, { "content-type": "application/mcp-server-card+json" });
        res.write('{"a":"');
        const t = setInterval(() => res.write("y".repeat(4096)), 1);
        res.on("close", () => clearInterval(t));
        return;
      }
      case "/redirect-same":
        return send(res, 302, undefined, "", { location: "/card" });
      case "/redirect-loop":
        return send(res, 302, undefined, "", { location: "/redirect-loop" });
      case "/redirect-cross":
        return send(res, 302, undefined, "", { location: `${otherBase}/card` });
      case "/wrong-type":
        return send(res, 200, "text/html", JSON.stringify(card()));
      case "/no-type":
        return send(res, 200, undefined, JSON.stringify(card()));
      case "/malformed":
        return send(res, 200, "application/mcp-server-card+json", '{"name": ');
      case "/invalid-card":
        return send(res, 200, "application/mcp-server-card+json", JSON.stringify({ name: "no-slash", version: "1" }));
      case "/slow":
        return; // never answers
      case "/404":
        return send(res, 404, "text/plain", "nope");
      case "/.well-known/ai-catalog.json":
        return send(
          res,
          200,
          "application/ai-catalog+json",
          JSON.stringify({
            specVersion: "1.0",
            host: { displayName: "Fixture Host" },
            entries: [
              { identifier: "urn:air:fixture:mcp:weather", type: "application/mcp-server-card+json", url: "/card" },
              { identifier: "urn:air:fixture:mcp:inline", type: "application/mcp-server-card+json", data: card({ name: "example-org/inline" }), displayName: "Inline one" },
              { identifier: "urn:air:fixture:mcp:far", type: "application/mcp-server-card+json", url: `${otherBase}/card` },
              { identifier: "urn:air:fixture:mcp:broken", type: "application/mcp-server-card+json", url: "/malformed" },
              { identifier: "urn:air:fixture:skill", type: "application/agent-skills+zip", url: "/skill.zip" },
              { identifier: "urn:air:fixture:mcp:both", type: "application/mcp-server-card+json", url: "/card", data: {} },
              "not an object",
            ],
          }),
        );
      default:
        return send(res, 404, "text/plain", "nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => other.close(r))]);
});

const opts = { allowInsecureLocalhost: true } as const;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DiscoveryError);
    return (e as DiscoveryError).code;
  }
  throw new Error("expected rejection");
};

describe("fetchServerCard", () => {
  it("fetches and validates a card, sending the card Accept header", async () => {
    const r = await fetchServerCard(`${base}/card`, opts);
    expect(r.card.name).toBe("example-org/weather");
    expect(r.card.remotes?.[0]?.type).toBe("streamable-http");
    expect(r.etag).toBe('"v1"');
  });

  it("sends Accept: application/mcp-server-card+json and omits credentials", async () => {
    let seen: { headers?: HeadersInit; credentials?: RequestCredentials; redirect?: RequestRedirect } = {};
    const fakeFetch = (async (_u: string, init: RequestInit) => {
      seen = init as typeof seen;
      return new Response(JSON.stringify(card()), { headers: { "content-type": "application/mcp-server-card+json" } });
    }) as unknown as typeof fetch;
    await fetchServerCard("https://example.com/mcp/server-card", { fetch: fakeFetch });
    expect((seen.headers as Record<string, string>).accept).toContain("application/mcp-server-card+json");
    expect(seen.credentials).toBe("omit");
    expect(seen.redirect).toBe("manual");
  });

  it("accepts application/json and follows a same-origin redirect", async () => {
    expect((await fetchServerCard(`${base}/card-json`, opts)).card.version).toBe("1.2.3");
    const r = await fetchServerCard(`${base}/redirect-same`, opts);
    expect(r.url).toBe(`${base}/card`);
  });

  it("refuses plain http unless loopback is explicitly allowed (and never non-loopback http)", async () => {
    expect(await code(fetchServerCard(`${base}/card`))).toBe("insecure_url");
    expect(await code(fetchServerCard("http://example.com/card", opts))).toBe("insecure_url");
    expect(await code(fetchServerCard("ftp://example.com/card", opts))).toBe("insecure_url");
    expect(await code(fetchServerCard("https://user:pw@example.com/card"))).toBe("invalid_url");
    expect(await code(fetchServerCard("not a url"))).toBe("invalid_url");
  });

  it("never reaches the network for a refused URL", async () => {
    let called = false;
    const spy = (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch;
    await code(fetchServerCard("http://example.com/card", { fetch: spy }));
    expect(called).toBe(false);
  });

  it("rejects an oversized response (declared and streamed)", async () => {
    expect(await code(fetchServerCard(`${base}/huge`, { ...opts, maxBytes: 1000 }))).toBe("too_large");
    expect(await code(fetchServerCard(`${base}/huge-stream`, { ...opts, maxBytes: 20_000 }))).toBe("too_large");
  });

  it("refuses a redirect to another origin without requesting it", async () => {
    hits["other/card"] = 0;
    expect(await code(fetchServerCard(`${base}/redirect-cross`, opts))).toBe("redirect_blocked");
    expect(hits["other/card"]).toBe(0);
  });

  it("bounds same-origin redirects", async () => {
    expect(await code(fetchServerCard(`${base}/redirect-loop`, opts))).toBe("too_many_redirects");
  });

  it("rejects a wrong or missing content type", async () => {
    expect(await code(fetchServerCard(`${base}/wrong-type`, opts))).toBe("bad_content_type");
    expect(await code(fetchServerCard(`${base}/no-type`, opts))).toBe("bad_content_type");
  });

  it("rejects malformed JSON and cards that fail the schema", async () => {
    expect(await code(fetchServerCard(`${base}/malformed`, opts))).toBe("malformed_json");
    expect(await code(fetchServerCard(`${base}/invalid-card`, opts))).toBe("invalid_document");
  });

  it("reports HTTP errors and times out", async () => {
    expect(await code(fetchServerCard(`${base}/404`, opts))).toBe("http_error");
    expect(await code(fetchServerCard(`${base}/slow`, { ...opts, timeoutMs: 150 }))).toBe("timeout");
  });
});

describe("schema", () => {
  it("requires $schema/name/version/description and keeps unknown members", async () => {
    const ok = await fetchServerCard(`${base}/card`, opts);
    expect(ok.card.name).toBe("example-org/weather");
    const p = (over: Record<string, unknown>) => code(Promise.resolve().then(() => import("../src/discovery/index.js").then((m) => m.parseServerCard(card(over)))));
    expect(await p({ $schema: "https://evil.example/schema.json" })).toBe("invalid_document");
    expect(await p({ description: "" })).toBe("invalid_document");
    expect(await p({ description: "x".repeat(101) })).toBe("invalid_document");
    expect(await p({ remotes: [{ type: "websocket", url: "https://a.example" }] })).toBe("invalid_document");
    const { parseServerCard } = await import("../src/discovery/index.js");
    expect((parseServerCard(card({ "com.vendor/x": 1 })) as Record<string, unknown>)["com.vendor/x"]).toBe(1);
  });
});

describe("discoverFromDomain", () => {
  it("reads the well-known catalog and resolves MCP entries (url, inline data, cross-origin)", async () => {
    const d = await discoverFromDomain(base.replace("http://", ""), opts);
    expect(d.catalogUrl).toBe(`${base}/.well-known/ai-catalog.json`);
    expect(d.specVersion).toBe("1.0");
    expect(d.hostName).toBe("Fixture Host");
    const byId = Object.fromEntries(d.entries.map((e) => [e.identifier, e]));
    expect(byId["urn:air:fixture:mcp:weather"]?.card?.name).toBe("example-org/weather");
    expect(byId["urn:air:fixture:mcp:weather"]?.sameOrigin).toBe(true);
    expect(byId["urn:air:fixture:mcp:inline"]?.source).toBe("data");
    expect(byId["urn:air:fixture:mcp:inline"]?.card?.name).toBe("example-org/inline");
    expect(byId["urn:air:fixture:mcp:far"]?.sameOrigin).toBe(false);
    expect(byId["urn:air:fixture:mcp:far"]?.card?.name).toBe("other-org/elsewhere");
    expect(byId["urn:air:fixture:mcp:broken"]?.error?.code).toBe("malformed_json");
    expect(byId["urn:air:fixture:skill"]).toBeUndefined();
    const reasons = d.skipped.map((s) => `${s.identifier ?? ""}|${s.reason}`).join("\n");
    expect(reasons).toContain("urn:air:fixture:skill");
    expect(reasons).toContain("exactly one of url or data");
    expect(reasons).toContain("malformed catalog entry");
  });

  it("can list entries without fetching cards, and caps entries", async () => {
    hits["/card"] = 0;
    const d = await discoverFromDomain(base.replace("http://", ""), { ...opts, resolveCards: false, maxEntries: 2 });
    expect(hits["/card"]).toBe(0);
    expect(d.entries).toHaveLength(2);
    expect(d.entries[0]?.cardUrl).toBe(`${base}/card`);
    expect(d.skipped.some((s) => s.reason.includes("maxEntries"))).toBe(true);
  });

  it("refuses non-https domains by default and malformed domain input", async () => {
    expect(await code(discoverFromDomain(base.replace("http://", "")))).toBe("network"); // https against a plain-http port
    expect(() => normalizeDomain("https://example.com")).toThrow(DiscoveryError);
    expect(() => normalizeDomain("example.com/path")).toThrow(DiscoveryError);
    expect(() => normalizeDomain("user@example.com")).toThrow(DiscoveryError);
    expect(normalizeDomain("Example.com:8443")).toBe("example.com:8443");
  });

  it("rejects catalogs from a newer major spec version and non-catalogs", async () => {
    const fake = (body: unknown) => (async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/ai-catalog+json" } })) as unknown as typeof fetch;
    expect(await code(discoverFromDomain("example.com", { fetch: fake({ specVersion: "2.0", entries: [] }) }))).toBe("unsupported_version");
    expect(await code(discoverFromDomain("example.com", { fetch: fake({ entries: [] }) }))).toBe("invalid_document");
    const ok = await discoverFromDomain("example.com", { fetch: fake({ specVersion: "0.9", entries: [] }) });
    expect(ok.entries).toEqual([]);
  });
});

describe("helpers", () => {
  it("recommendedCardUrl appends /server-card to the streamable-http URL", () => {
    expect(recommendedCardUrl("https://host/mcp")).toBe("https://host/mcp/server-card");
    expect(recommendedCardUrl("https://host/mcp/?a=1#x")).toBe("https://host/mcp/server-card");
  });

  it("resolveRemote substitutes variables and reports missing ones", () => {
    const c = JSON.parse(
      JSON.stringify(
        card({
          remotes: [
            {
              type: "streamable-http",
              url: "https://{region}.example.com/{tenant}/mcp",
              variables: { region: { default: "eu" }, tenant: { isRequired: true } },
              headers: [{ name: "X-Key", isSecret: true, isRequired: true }],
            },
          ],
        }),
      ),
    ) as ServerCard;
    const remote = selectRemote(c)!;
    const r1 = resolveRemote(remote);
    expect(r1.url).toBeUndefined();
    expect(r1.missing).toEqual(["tenant"]);
    expect(r1.headers).toEqual([{ name: "X-Key", isRequired: true, isSecret: true }]);
    const r2 = resolveRemote(remote, { tenant: "acme" });
    expect(r2.url).toBe("https://eu.example.com/acme/mcp");
    expect(connectableRemoteUrl(r2)).toBe("https://eu.example.com/acme/mcp");
    expect(() => connectableRemoteUrl(r1)).toThrow(DiscoveryError);
    const insecure = resolveRemote({ type: "sse", url: "http://example.com/sse" });
    expect(() => connectableRemoteUrl(insecure)).toThrow(DiscoveryError);
  });

  it("sanitizeForDisplay strips escapes and control characters", () => {
    expect(sanitizeForDisplay("ok\u001b[31mred\u001b[0m\u001b]0;title\u0007 ‮evil\u0000")).toBe("okred evil");
    expect(sanitizeForDisplay("a".repeat(500), 10)).toBe("aaaaaaaaaa…");
  });

  it("compareCardToLive flags version and protocol disagreement", () => {
    const c = card() as unknown as ServerCard;
    expect(compareCardToLive(c, { serverInfo: { name: "weather", version: "1.2.3" }, negotiatedVersion: "2026-07-28", supportedVersions: ["2025-11-25", "2026-07-28"] })).toEqual([]);
    const f = compareCardToLive(c, { serverInfo: { name: "other", version: "9.9.9" }, negotiatedVersion: "2024-11-05", supportedVersions: ["2026-07-28", "2027-01-01"], connectedUrl: "http://127.0.0.1:1/mcp" });
    expect(f.map((x) => x.field).sort()).toEqual(["name", "negotiatedVersion", "supportedProtocolVersions", "version"]);
    const note = compareCardToLive(c, { negotiatedVersion: "2025-11-25" });
    expect(note.map((x) => x.kind)).toEqual(["note"]);
    expect(compareCardToLive(c, { connectedUrl: "https://elsewhere.example/mcp" }).some((x) => x.field === "remote")).toBe(true);
  });
});
