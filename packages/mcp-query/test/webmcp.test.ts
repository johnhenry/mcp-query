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

  // ── native WebMCP / @mcp-b/global 5.1 shape ──
  // Source: @mcp-b/webmcp-types@5.1.0 dist/model-context.d.ts
  //   getTools(options?): Promise<RegisteredTool[]>   (descriptors: no `execute`; `window`, `origin`)
  //   executeTool?(tool: RegisteredTool, inputArguments: string, options?): Promise<string | null>
  //   RegisteredTool.inputSchema: object | JSON string (Chrome 149-153 return the string)
  // and @mcp-b/global README: `executeTool(searchTool, JSON.stringify({...}))` -> JSON string.
  function nativeModelContext(opts: { schemaAsString?: boolean; withExecute?: boolean } = {}) {
    const impls = new Map<string, (a: Record<string, unknown>) => unknown>([
      ["echo", (a) => ({ content: [{ type: "text", text: `echo:${(a as { msg: string }).msg}` }] })],
      ["nothing", () => undefined],
      ["boom", () => { throw new Error("kaboom"); }],
    ]);
    const schema = { type: "object", properties: { msg: { type: "string" } } };
    const descriptors = [...impls.keys()].map((name) => ({
      name,
      title: "",
      description: `${name} tool`,
      inputSchema: opts.schemaAsString ? JSON.stringify(schema) : schema,
      window: {} as unknown,
      origin: "https://example.test",
    }));
    const calls: unknown[][] = [];
    const mc = {
      registerTool: async () => undefined,
      getTools: async () => descriptors,
      executeTool: async (tool: unknown, inputArguments: unknown) => {
        calls.push([tool, inputArguments]);
        if (typeof tool !== "object" || tool === null) throw new TypeError("executeTool: tool must be a RegisteredTool");
        if (typeof inputArguments !== "string") throw new TypeError("executeTool: inputArguments must be a JSON string");
        const impl = impls.get((tool as { name: string }).name)!;
        const out = await impl(JSON.parse(inputArguments));
        return out === undefined ? null : JSON.stringify(out);
      },
    };
    if (opts.withExecute === false) delete (mc as { executeTool?: unknown }).executeTool;
    return { mc: mc as unknown as ModelContext, calls, descriptors };
  }

  it("calls native executeTool(tool descriptor, JSON string) and parses the JSON-string result", async () => {
    const { mc, calls, descriptors } = nativeModelContext();
    const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
    await client.connect();
    const res = (await client.callTool("page.echo", { msg: "hi" })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("echo:hi");
    expect(calls[0]![0]).toBe(descriptors[0]);
    expect(calls[0]![1]).toBe('{"msg":"hi"}');
    await client.close();
  });

  it("maps a null native result to a null text result", async () => {
    const { mc } = nativeModelContext();
    const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
    await client.connect();
    const res = (await client.callTool("page.nothing", {})) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("null");
    await client.close();
  });

  it("parses JSON-string inputSchema (Chrome 149-153) in tools/list", async () => {
    const { mc } = nativeModelContext({ schemaAsString: true });
    const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
    await client.connect();
    const tool = client.listTools("page").find((t) => t.name === "echo")!;
    expect(tool.inputSchema).toEqual({ type: "object", properties: { msg: { type: "string" } } });
    await client.close();
  });

  it("falls back to navigator.modelContextTesting.executeTool(name, json) when executeTool is absent", async () => {
    const { mc } = nativeModelContext({ withExecute: false });
    const testing = { executeTool: vi.fn(async (name: string, json: string) => JSON.stringify({ name, got: JSON.parse(json) })) };
    const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { modelContextTesting: testing }, configurable: true });
    try {
      const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
      await client.connect();
      const res = (await client.callTool("page.echo", { msg: "t" })) as { content: { text: string }[] };
      expect(JSON.parse(res.content[0]!.text)).toEqual({ name: "echo", got: { msg: "t" } });
      expect(testing.executeTool).toHaveBeenCalledWith("echo", '{"msg":"t"}');
      await client.close();
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it("errors clearly for an unknown tool and when no execution path exists", async () => {
    const { mc } = nativeModelContext({ withExecute: false });
    const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
    await client.connect();
    await expect(client.callTool("page.echo", { msg: "x" })).rejects.toThrow(/does not support executeTool/);
    await client.close();
  });

  it("still supports the legacy executeTool(name, args) shape", async () => {
    // covered by the first webMcpToolServer test (fake descriptors carry `execute`); assert the name form is used
    const seen: unknown[] = [];
    const mc = fakeModelContext([{ name: "t", execute: () => "ok" }]);
    const orig = mc.executeTool!;
    mc.executeTool = (a: never, b: never) => (seen.push(a), orig(a, b));
    const client = new MCPClient({ servers: { page: webMcpToolServer(mc) } });
    await client.connect();
    await client.callTool("page.t", {});
    expect(seen).toEqual(["t"]);
    await client.close();
  });
});

describe("default model context lookup", () => {
  it("falls back to navigator.modelContext when document.modelContext is absent", () => {
    const mc = fakeModelContext();
    const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { modelContext: mc }, configurable: true });
    try {
      expect(() => webMcpToolServer()).not.toThrow();
    } finally {
      if (nav) Object.defineProperty(globalThis, "navigator", nav);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});

describe("bridgeToWebMCP against native registerTool (Promise<void>)", () => {
  it("does not leak an unhandled rejection when registerTool rejects", async () => {
    const server = new MockMCPServer({ tools: [{ name: "a", handler: () => ({ content: [] }) }] });
    const client = new MCPClient({ servers: { srv: { transport: server.transport } } });
    await client.connect();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const mc = { registerTool: () => Promise.reject(new Error("duplicate tool")) } as unknown as ModelContext;
    const stop = bridgeToWebMCP(client, "srv", { modelContext: mc });
    await tick(20);
    process.off("unhandledRejection", unhandled);
    stop();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
