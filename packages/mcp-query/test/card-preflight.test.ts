// #85: ConnectionConfig.cardPreflight seeds `versions` from the server's card, never fatally,
// and always defers to the live server.
import { describe, expect, it, vi } from "vitest";
import { ServerConnection } from "../src/core/connection.js";
import { MCPCache } from "../src/core/cache.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { cardProtocolVersions } from "../src/discovery/index.js";

const CARD_URL = "https://srv.example/mcp/server-card";

function cardFetch(versions: string[] | undefined, status = 200) {
  const card = {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "com.example/srv",
    version: "1",
    description: "d",
    remotes: [{ type: "streamable-http", url: "https://srv.example/mcp", ...(versions ? { supportedProtocolVersions: versions } : {}) }],
  };
  return vi.fn(async () =>
    status === 200
      ? new Response(JSON.stringify(card), { status, headers: { "content-type": "application/mcp-server-card+json" } })
      : new Response("nope", { status }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function connect(mock: MockMCPServer, f: typeof fetch, extra: Record<string, unknown> = {}) {
  const conn = new ServerConnection(
    "s",
    { transport: mock.transport, maxRetries: 0, cardPreflight: { cardUrl: CARD_URL, serverUrl: "https://srv.example/mcp", fetch: f }, ...extra },
    { cache: new MCPCache(), handlers: {} },
  );
  await conn.connect();
  return conn;
}

describe("cardPreflight", () => {
  it("a card listing a modern revision seeds modern negotiation (default would be legacy)", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const f = cardFetch(["2026-07-28", "2025-11-25"]);
    const conn = await connect(mock, f);
    expect(conn.era).toBe("modern");
    expect(conn.tools.has("t")).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    await conn.close();
    await mock.close();
  });

  it("a legacy-only card selects the plain handshake with no probe", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const conn = await connect(mock, cardFetch(["2025-11-25"]));
    expect(conn.era).toBe("legacy");
    await conn.close();
    await mock.close();
  });

  it("a failed or unusable card fetch is non-fatal: the connection uses its normal configuration", async () => {
    for (const f of [cardFetch(undefined, 404), cardFetch(undefined), vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch]) {
      const mock = new MockMCPServer({ tools: [{ name: "t" }] });
      const conn = await connect(mock, f);
      expect(conn.era).toBe("legacy"); // unconfigured default
      expect(conn.tools.has("t")).toBe(true);
      await conn.close();
      await mock.close();
    }
  });

  it("a stale card (modern-only, live server is legacy) falls back to the normal handshake", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] }, { era: "legacy" });
    const conn = await connect(mock, cardFetch(["2026-07-28"]));
    expect(conn.era).toBe("legacy");
    expect(conn.tools.has("t")).toBe(true);
    await conn.close();
    await mock.close();
  });

  it("explicit versions win and the card is not even fetched", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const f = cardFetch(["2025-11-25"]);
    const conn = await connect(mock, f, { versions: ["2026-07-28", "2025-11-25"] });
    expect(conn.era).toBe("modern");
    expect(f).not.toHaveBeenCalled();
    await conn.close();
    await mock.close();
  });

  it("cardProtocolVersions picks the remote matching serverUrl and never throws", async () => {
    const card = {
      $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
      name: "com.example/srv",
      version: "1",
      description: "d",
      remotes: [
        { type: "streamable-http", url: "https://a.example/mcp", supportedProtocolVersions: ["2025-11-25"] },
        { type: "streamable-http", url: "https://b.example/mcp", supportedProtocolVersions: ["2026-07-28"] },
      ],
    };
    const f = (async () => new Response(JSON.stringify(card), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await cardProtocolVersions({ cardUrl: CARD_URL, serverUrl: "https://b.example/mcp", fetch: f })).toEqual(["2026-07-28"]);
    expect(await cardProtocolVersions({ cardUrl: CARD_URL, fetch: f })).toEqual(["2025-11-25"]);
    expect(await cardProtocolVersions({ cardUrl: "http://insecure.example/c", fetch: f })).toBeUndefined();
  });
});
