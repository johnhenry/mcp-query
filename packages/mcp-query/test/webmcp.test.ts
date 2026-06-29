import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { bridgeToWebMCP, webMcpToolServer, type ModelContext, type WebMCPToolDef } from "../src/webmcp/index.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** A fake WebMCP host that records registrations (B) and serves tools (A). */
function fakeModelContext(seed: WebMCPToolDef[] = []) {
  const registered = new Map<string, WebMCPToolDef>();
  const tools = [...seed];
  const mc: ModelContext & {
    names: () => string[];
    call: (name: string, args: Record<string, unknown>) => unknown;
  } = {
    registerTool(def, opts) {
      registered.set(def.name, def);
      opts?.signal?.addEventListener("abort", () => registered.delete(def.name));
    },
    getTools: () => tools,
    executeTool: (name, args) => {
      const t = tools.find((x) => x.name === name);
      return t?.execute(args);
    },
    names: () => [...registered.keys()],
    call: (name, args) => registered.get(name)!.execute(args),
  };
  return mc;
}

// ───────────────────────── B: mcp-query → WebMCP ─────────────────────────
describe("bridgeToWebMCP", () => {
  async function setup() {
    const server = new MockMCPServer({
      tools: [
        { name: "search", annotations: { readOnlyHint: true }, handler: (a) => ({ content: [{ type: "text", text: `hits:${(a as { q: string }).q}` }] }) },
        { name: "delete", annotations: { destructiveHint: true }, handler: () => ({ content: [{ type: "text", text: "deleted" }] }) },
      ],
    });
    const client = new MCPClient({ servers: { srv: { transport: server.transport } } });
    await client.connect();
    return { client, server };
  }

  it("registers a WebMCP tool per backend tool and routes execute through the client", async () => {
    const { client } = await setup();
    const mc = fakeModelContext();
    const stop = bridgeToWebMCP(client, "srv", { modelContext: mc });

    expect(mc.names().sort()).toEqual(["srv.delete", "srv.search"]);
    const out = (await mc.call("srv.search", { q: "x" })) as { content: { text: string }[] };
    expect(out.content[0]!.text).toBe("hits:x");
    stop();
  });

  it("gates invocations through `confirm`", async () => {
    const { client } = await setup();
    const mc = fakeModelContext();
    const confirm = vi.fn(({ tool }) => tool.name !== "delete"); // deny destructive
    bridgeToWebMCP(client, "srv", { modelContext: mc, confirm });

    await expect(mc.call("srv.delete", {})).rejects.toThrow(/denied by host/);
    expect(confirm).toHaveBeenCalled();
    await expect(mc.call("srv.search", { q: "ok" })).resolves.toBeTruthy();
  });

  it("re-syncs on tools/list_changed and stop() unregisters all", async () => {
    const { client, server } = await setup();
    const mc = fakeModelContext();
    const stop = bridgeToWebMCP(client, "srv", { modelContext: mc });
    expect(mc.names()).toHaveLength(2);

    server.spec.tools = [{ name: "search" }, { name: "delete" }, { name: "rename" }];
    await server.notifyToolListChanged();
    await tick();
    expect(mc.names()).toContain("srv.rename");

    server.spec.tools = [{ name: "search" }];
    await server.notifyToolListChanged();
    await tick();
    expect(mc.names()).toEqual(["srv.search"]);

    stop();
    expect(mc.names()).toHaveLength(0);
    await client.close();
  });
});

// ───────────────────────── A: WebMCP → mcp-query ─────────────────────────
describe("webMcpToolServer", () => {
  it("consumes a page's WebMCP tools as an ordinary mcp-query server", async () => {
    const mc = fakeModelContext([
      {
        name: "highlight",
        description: "Highlight text on the page",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        execute: (args) => ({ highlighted: (args as { text: string }).text.toUpperCase() }),
      },
    ]);

    const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
    await client.connect();

    expect(client.listTools("page").map((t) => t.name)).toEqual(["highlight"]);
    const res = (await client.callTool("page.highlight", { text: "hi" })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0]!.text)).toEqual({ highlighted: "HI" });

    // and it caches like any other tool query
    await client.queryTool("page.highlight", { text: "yo" });
    expect(client.cache.getSnapshot({ kind: "toolResult", server: "page", tool: "highlight", argsHash: '{"text":"yo"}' })?.status).toBe("success");
    await client.close();
  });
});
