// #85: the inspector's Server Card view. Card text is untrusted: no HTML injection, no image loads.
import { beforeEach, describe, expect, it } from "vitest";
import { cardUrlFor, liveFactsFrom, loadCardView, viewCard } from "../src/lib/card.js";
import "../src/components/card.js";
import { activeServer } from "../src/lib/store.js";

const SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
const card = (over: Record<string, unknown> = {}) => ({
  $schema: SCHEMA,
  name: "com.example/srv",
  version: "1.0.0",
  description: "Example server",
  remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2026-07-28"] }],
  ...over,
});
const fetcher = (doc: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/mcp-server-card+json" } })) as unknown as typeof fetch;
const sdk = (over = {}) => ({ getServerVersion: () => ({ name: "srv", version: "1.0.0" }), getNegotiatedProtocolVersion: () => "2026-07-28", getDiscoverResult: () => ({ supportedVersions: ["2026-07-28"] }), ...over });

describe("card lib", () => {
  it("cardUrlFor follows SEP-2127 for http servers and is undefined for stdio", () => {
    expect(cardUrlFor({ transport: "http", url: "https://srv.example/mcp/" })).toBe("https://srv.example/mcp/server-card");
    expect(cardUrlFor({ transport: "stdio" })).toBeUndefined();
    expect(cardUrlFor({ transport: "sse", url: "https://x/sse" })).toBeUndefined();
    expect(cardUrlFor(undefined)).toBeUndefined();
  });

  it("shows no disagreement when the card matches the live connection", async () => {
    const v = await loadCardView("https://srv.example/mcp/server-card", liveFactsFrom(sdk(), "https://srv.example/mcp"), { fetch: fetcher(card()) });
    expect(v.findings.filter((f) => f.kind === "differs")).toEqual([]);
    expect(v.remotes).toEqual([{ type: "streamable-http", url: "https://srv.example/mcp", versions: ["2026-07-28"] }]);
  });

  it("shows disagreement with the live server", async () => {
    const stale = card({ version: "0.9", remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2025-11-25"] }] });
    const v = await loadCardView("https://srv.example/mcp/server-card", liveFactsFrom(sdk(), "https://srv.example/mcp"), { fetch: fetcher(stale) });
    const msgs = v.findings.filter((f) => f.kind === "differs").map((f) => f.message).join("\n");
    expect(msgs).toContain("card version 0.9 vs live 1.0.0");
    expect(msgs).toContain("negotiated 2026-07-28, which the card does not list");
  });

  it("rejects a document that is not a card and an HTTP error", async () => {
    await expect(loadCardView("https://srv.example/c", {}, { fetch: fetcher({ nope: 1 }) })).rejects.toThrow(/not a valid Server Card/);
    await expect(loadCardView("https://srv.example/c", {}, { fetch: fetcher({}, 404) })).rejects.toThrow(/404/);
  });

  it("strips control characters from card text", () => {
    const v = viewCard(card({ description: "hi\u001b[31m red\u0007", title: "T‮evil" }) as never, "https://srv.example/c", {});
    expect(JSON.stringify(v)).not.toMatch(/[\u0000-\u0008\u001b‮]/);
  });
});

describe("card panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sessionStorage.clear();
  });

  it("renders hostile card text as text, never as markup, and never loads icons", async () => {
    sessionStorage.setItem("mcp-spec:evil", JSON.stringify({ name: "evil", transport: "http", url: "https://srv.example/mcp" }));
    activeServer.set("evil");
    const hostile = card({
      description: "<img src=x onerror=window.__pwned=1>",
      title: "<script>window.__pwned=1</script>",
      websiteUrl: "javascript:window.__pwned=1",
      icons: [{ src: "https://tracker.example/pixel.png" }],
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetcher(hostile);
    try {
      const panel = document.createElement("mcp-card");
      document.body.append(panel);
      expect((panel.querySelector("#card-url") as HTMLInputElement).value).toBe("https://srv.example/mcp/server-card");
      (panel.querySelector("#fetch-card") as HTMLButtonElement).click();
      for (let i = 0; i < 100 && !panel.querySelector("dl"); i++) await new Promise((r) => setTimeout(r, 10));
      expect(panel.querySelector("dl")).toBeTruthy();
      expect(panel.querySelector("img, script, a, iframe")).toBeNull();
      expect(panel.textContent).toContain("<img src=x onerror=window.__pwned=1>"); // shown literally
      expect(panel.textContent).toContain("https://tracker.example/pixel.png"); // listed, not loaded
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
      activeServer.set("");
    }
  });

  it("says stdio servers have no card", () => {
    sessionStorage.setItem("mcp-spec:local", JSON.stringify({ name: "local", transport: "stdio" }));
    activeServer.set("local");
    const panel = document.createElement("mcp-card");
    document.body.append(panel);
    expect(panel.querySelector("#card-note")!.textContent).toMatch(/not an HTTP server/);
    activeServer.set("");
  });
});
