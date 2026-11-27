// #85: the Server Card is an optional part of the v2 contract; a changed endpoint or a dropped protocol version is drift.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { captureContract, cardForContract, diffContract, upgradeContract, type Contract, type ContractCard } from "../src/contract.js";
import { formatDiff } from "../src/report.js";

const base = (over: Partial<Contract> = {}): Contract => ({ version: 2, tools: [], resources: [], templates: [], prompts: [], ...over });
const card = (over: Partial<ContractCard> = {}): ContractCard => ({
  name: "com.example/srv",
  remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }],
  ...over,
});
const cardChanges = (a?: ContractCard, b?: ContractCard) => diffContract(base({ card: a }), base({ card: b })).changes.filter((c) => c.category === "card");

describe("contract card", () => {
  it("captureContract records a supplied card and omits the field otherwise", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "modern" });
    const client = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await client.connect(mock.transport());
    const withCard = await captureContract(client, { card: card() });
    const without = await captureContract(client);
    await client.close();
    expect(withCard.card).toEqual(card());
    expect(without).not.toHaveProperty("card");
  });

  it("cardForContract keeps identity and remotes only, sorted versions, no tools or other members", () => {
    const c = cardForContract(
      { name: "com.example/srv", remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2026-07-28", "2025-11-25"], headers: [{ name: "x" }] } as never], tools: [{ name: "leak" } ] } as never,
      "https://srv.example/mcp/server-card",
    );
    expect(c).toEqual({
      url: "https://srv.example/mcp/server-card",
      name: "com.example/srv",
      remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }],
    });
  });

  it("an unchanged card is no change", () => {
    expect(cardChanges(card(), card())).toEqual([]);
  });

  it("a dropped protocol version is breaking; an added one is compatible", () => {
    const dropped = cardChanges(card(), card({ remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2026-07-28"] }] }));
    expect(dropped).toEqual([{ category: "card", target: "https://srv.example/mcp", level: "breaking", detail: "card no longer lists protocol version 2025-11-25" }]);
    const added = cardChanges(card({ remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", supportedProtocolVersions: ["2025-11-25"] }] }), card());
    expect(added.map((c) => [c.level, c.detail])).toEqual([["compatible", "card now lists protocol version 2026-07-28"]]);
  });

  it("a moved endpoint is breaking (old removed) plus compatible (new added)", () => {
    const moved = cardChanges(card(), card({ remotes: [{ type: "streamable-http", url: "https://new.example/mcp", supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }] }));
    expect(moved.map((c) => [c.level, c.target])).toEqual([
      ["breaking", "https://srv.example/mcp"],
      ["compatible", "https://new.example/mcp"],
    ]);
  });

  it("a renamed card is drift and a transport change is breaking", () => {
    expect(cardChanges(card(), card({ name: "com.example/other" })).map((c) => c.level)).toEqual(["drift"]);
    expect(cardChanges(card(), card({ remotes: [{ type: "sse", url: "https://srv.example/mcp", supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }] })).map((c) => c.level)).toEqual(["breaking"]);
  });

  it("only compares when both sides captured a card (v1/old pins and card-less captures are not drift)", () => {
    expect(cardChanges(undefined, card())).toEqual([]);
    expect(cardChanges(card(), undefined)).toEqual([]);
    expect(upgradeContract({ version: 1, tools: [] })).not.toHaveProperty("card");
  });

  it("breaking card changes show up in the report and count as breaking", () => {
    const d = diffContract(base({ card: card() }), base({ card: card({ remotes: [] }) }));
    expect(d.breaking).toBe(1);
    expect(formatDiff(d, { color: false })).toContain("endpoint no longer listed");
  });
});
