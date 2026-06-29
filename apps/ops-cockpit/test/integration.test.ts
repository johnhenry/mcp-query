// Integration: two mock MCP servers behind a single MCPClient (InMemoryTransport via
// MockMCPServer). Asserts the tile data the cockpit derives — connection state,
// capability counts, health→status — is correct, and that the ActivityStore captures
// the onCall audit stream. No DOM, no proxy: pure client-level wiring.

import { describe, it, expect } from "vitest";
import { MCPClient, isReadOnly } from "mcp-query";
import { MockMCPServer } from "mcp-query/testing";
import { healthToTileStatus } from "../src/lib/tile-status.js";
import { ActivityStore } from "../src/lib/activity.js";

function makeServers() {
  const alpha = new MockMCPServer({
    tools: [
      { name: "search", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "hit" }] }) },
      { name: "deploy", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "deployed" }] }) },
    ],
    resources: [{ uri: "alpha://doc", name: "doc" }],
    prompts: [{ name: "greet" }],
  });
  const beta = new MockMCPServer({
    tools: [{ name: "ping", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "pong" }] }) }],
  });
  return { alpha, beta };
}

describe("cockpit tile derivation over two mock servers", () => {
  it("derives state + capability counts per server", async () => {
    const { alpha, beta } = makeServers();
    const client = new MCPClient({
      servers: { alpha: { transport: alpha.transport }, beta: { transport: beta.transport } },
    });
    await client.connect();

    const names = client.connections().map((c) => c.name).sort();
    expect(names).toEqual(["alpha", "beta"]);

    // Per-tile capability counts come straight off the client list methods.
    expect(client.listTools("alpha")).toHaveLength(2);
    expect(client.listResources("alpha")).toHaveLength(1);
    expect(client.listPrompts("alpha")).toHaveLength(1);

    expect(client.listTools("beta")).toHaveLength(1);
    expect(client.listResources("beta")).toHaveLength(0);
    expect(client.listPrompts("beta")).toHaveLength(0);

    // State is "ready" for both, and health() pings succeed → healthy tiles.
    expect(client.serverState("alpha")).toBe("ready");
    const health = await client.health();
    expect(healthToTileStatus(health.alpha)).toBe("healthy");
    expect(healthToTileStatus(health.beta)).toBe("healthy");
    expect(health.alpha!.ok).toBe(true);
    expect(typeof health.alpha!.pingMs).toBe("number");

    await client.close();
  });

  it("identifies read-only tools for the watch widget", async () => {
    const { alpha, beta } = makeServers();
    const client = new MCPClient({
      servers: { alpha: { transport: alpha.transport }, beta: { transport: beta.transport } },
    });
    await client.connect();

    const alphaTools = client.listTools("alpha");
    const readOnly = alphaTools.filter(isReadOnly).map((t) => t.name);
    expect(readOnly).toEqual(["search"]); // "deploy" is destructive, not read-only
    expect(client.listTools("beta").every(isReadOnly)).toBe(true);

    await client.close();
  });

  it("feeds the ActivityStore from onCall audit entries", async () => {
    const { alpha, beta } = makeServers();
    const activity = new ActivityStore();
    const client = new MCPClient({
      servers: { alpha: { transport: alpha.transport }, beta: { transport: beta.transport } },
      onCall: (e) => activity.push(e),
    });
    await client.connect();

    await client.callTool("alpha.search", {});
    await client.queryTool("beta.ping", {});

    const rows = activity.getSnapshot();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // newest-first; both should be successful audit rows for the right servers.
    const servers = rows.map((r) => r.server);
    expect(servers).toContain("alpha");
    expect(servers).toContain("beta");
    expect(rows.every((r) => r.source === "audit")).toBe(true);
    expect(rows.filter((r) => r.ok).length).toBeGreaterThanOrEqual(2);

    await client.close();
  });

  it("reflects a degraded tile when a server enters a non-ready/failed state", () => {
    // Pure mapping check mirroring what a killed server produces in the live UI.
    expect(healthToTileStatus({ state: "failed", ok: false })).toBe("failed");
    expect(healthToTileStatus({ state: "reconnecting", ok: false })).toBe("degraded");
    expect(healthToTileStatus({ state: "ready", ok: false })).toBe("degraded");
  });
});
