// SEP-2577 deprecation warnings (dev-only, one-time, silenceable) and the optional `_meta` the draft
// revision restores on sampling / elicitation / roots types: it must pass through the handlers and the
// InteractionBroker in both directions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { installHandlers, rootsResult } from "../src/core/handlers.js";
import { InteractionBroker } from "../src/core/interactions.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { isDevelopment, resetDeprecationWarnings, silenceDeprecationWarnings, warnDeprecatedFeature } from "../src/core/deprecations.js";

type Handler = (req: { params?: unknown }) => unknown;
function fakeClient() {
  const handlers = new Map<string, Handler>();
  return { client: { setRequestHandler: (m: string, h: Handler) => void handlers.set(m, h) } as never, handlers };
}

describe("deprecation warnings", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST, silence: process.env.MCP_QUERY_SILENCE_DEPRECATIONS };
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetDeprecationWarnings();
    silenceDeprecationWarnings(false);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    for (const [k, v] of [["NODE_ENV", saved.NODE_ENV], ["VITEST", saved.VITEST], ["MCP_QUERY_SILENCE_DEPRECATIONS", saved.silence]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const dev = () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
  };

  it("does not fire in tests by default", () => {
    expect(isDevelopment()).toBe(false);
    warnDeprecatedFeature("sampling", "s");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fires once per feature in development, naming SEP-2577 and the twelve-month window", () => {
    dev();
    warnDeprecatedFeature("sampling", "srv");
    warnDeprecatedFeature("sampling", "srv");
    warnDeprecatedFeature("roots");
    expect(warn).toHaveBeenCalledTimes(2);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain('server "srv"');
    expect(msg).toContain("SEP-2577");
    expect(msg).toContain("SEP-2596");
    expect(msg).toContain("twelve months");
  });

  it("is silenceable by function and by environment, and quiet in production", () => {
    dev();
    silenceDeprecationWarnings();
    warnDeprecatedFeature("sampling");
    silenceDeprecationWarnings(false);
    process.env.MCP_QUERY_SILENCE_DEPRECATIONS = "1";
    warnDeprecatedFeature("sampling");
    delete process.env.MCP_QUERY_SILENCE_DEPRECATIONS;
    process.env.NODE_ENV = "production";
    warnDeprecatedFeature("sampling");
    expect(warn).not.toHaveBeenCalled();
  });

  it("the handlers warn when a MODERN-era server asks for sampling or roots, never for a legacy-era server", async () => {
    dev();
    const legacy = fakeClient();
    installHandlers(legacy.client, { sampling: async () => ({}), roots: () => [] }, { server: "old", era: () => "legacy" });
    await legacy.handlers.get("sampling/createMessage")!({ params: {} });
    legacy.handlers.get("roots/list")!({ params: {} });
    expect(warn).not.toHaveBeenCalled();

    const modern = fakeClient();
    installHandlers(modern.client, { sampling: async () => ({}), roots: () => [] }, { server: "new", era: () => "modern" });
    await modern.handlers.get("sampling/createMessage")!({ params: {} });
    modern.handlers.get("roots/list")!({ params: {} });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toContain('"new"');
  });

  it("a real modern-era round that asks for roots warns once (and works)", async () => {
    dev();
    const mock = new MockMCPServer({ tools: [{ name: "where", handler: async (_a, ctx) => ({ content: [{ type: "text", text: (await ctx.listRoots()).roots.map((r) => r.uri).join(",") }] }) }] }, { era: "modern" });
    const client = new MCPClient({ servers: { s: { transport: mock.transport, versionNegotiation: { mode: "auto" } } }, handlers: { roots: () => [{ uri: "file:///w" }] } });
    await client.connect();
    const r = (await client.callTool("s.where", {})) as { content: Array<{ text: string }> };
    expect(r.content[0]!.text).toBe("file:///w");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("roots"))).toHaveLength(1);
    await client.close();
  });
});

describe("_meta passes through handlers and the broker, both directions", () => {
  const meta = { "vendor/trace": "abc" };

  it("sampling: request params (with _meta) reach the handler; a result _meta comes back", async () => {
    const { client, handlers } = fakeClient();
    let seen: unknown;
    installHandlers(client, { sampling: async (req) => ((seen = req), { role: "assistant", content: { type: "text", text: "x" }, model: "m", _meta: { out: 1 } }) });
    const res = (await handlers.get("sampling/createMessage")!({ params: { messages: [], maxTokens: 1, _meta: meta } })) as { _meta?: unknown };
    expect((seen as { _meta?: unknown })._meta).toEqual(meta);
    expect(res._meta).toEqual({ out: 1 });
  });

  it("elicitation: form and url params (with _meta) reach the handler; a result _meta comes back", async () => {
    const { client, handlers } = fakeClient();
    const seen: unknown[] = [];
    installHandlers(client, { elicitation: async (req) => (seen.push(req), { action: "accept", content: {}, _meta: { ok: true } }) });
    const h = handlers.get("elicitation/create")!;
    const a = (await h({ params: { mode: "form", message: "m", requestedSchema: {}, _meta: meta } })) as { _meta?: unknown };
    await h({ params: { mode: "url", message: "m", url: "https://x", _meta: meta } });
    expect(seen.map((s) => (s as { _meta?: unknown })._meta)).toEqual([meta, meta]);
    expect(a._meta).toEqual({ ok: true });
  });

  it("roots: the request _meta is the handler's argument; { roots, _meta } and plain arrays both work", async () => {
    const { client, handlers } = fakeClient();
    let arg: unknown;
    installHandlers(client, { roots: (req) => ((arg = req), { roots: [{ uri: "file:///a" }], _meta: { r: 1 } }) });
    const res = (await handlers.get("roots/list")!({ params: { _meta: meta } })) as { roots: unknown[]; _meta?: unknown };
    expect(arg).toEqual({ _meta: meta });
    expect(res).toEqual({ roots: [{ uri: "file:///a" }], _meta: { r: 1 } });
    expect(rootsResult(() => [{ uri: "file:///b" }])).toEqual({ roots: [{ uri: "file:///b" }] });
  });

  it("the broker keeps _meta on sampling params, passes it to the model, and returns a model/author result _meta", async () => {
    let seen: unknown;
    const broker = new InteractionBroker({
      policy: () => "allow",
      model: async (req) => ((seen = req), { role: "assistant", content: { type: "text", text: "x" }, model: "m", _meta: { out: 2 } }),
    });
    const res = (await broker.handleSampling("s", { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 5, _meta: meta })) as { _meta?: unknown };
    expect((seen as { _meta?: unknown })._meta).toEqual(meta);
    expect(res._meta).toEqual({ out: 2 });

    const manual = new InteractionBroker({ manualSampling: true, policy: () => "ask" });
    const pending = manual.handleSampling("s", { messages: [], maxTokens: 1, _meta: meta });
    await vi.waitFor(() => expect(manual.list().length).toBe(1));
    expect((manual.list()[0]!.payload as { _meta?: unknown })._meta).toEqual(meta); // the UI sees the request _meta
    manual.resolve(manual.list()[0]!.id, { action: "approve", editedResult: { role: "assistant", content: { type: "text", text: "a" }, model: "h", _meta: { by: "human" } } });
    expect(((await pending) as { _meta?: unknown })._meta).toEqual({ by: "human" });
  });

  it("the broker keeps _meta on elicitation params and returns the decision's _meta on the result", async () => {
    const broker = new InteractionBroker({ policy: () => "ask" });
    const p = broker.handleElicitation("s", { mode: "form", message: "q", requestedSchema: {}, _meta: meta } as never);
    await vi.waitFor(() => expect(broker.list().length).toBe(1));
    expect((broker.list()[0]!.payload as { _meta?: unknown })._meta).toEqual(meta);
    broker.resolve(broker.list()[0]!.id, { action: "approve", content: { a: 1 }, _meta: { by: "ui" } });
    expect(await p).toEqual({ action: "accept", content: { a: 1 }, _meta: { by: "ui" } });

    const q = broker.handleElicitation("s", { message: "q", requestedSchema: {} });
    await vi.waitFor(() => expect(broker.list().length).toBe(1));
    broker.resolve(broker.list()[0]!.id, { action: "approve", content: {} });
    expect(await q).toEqual({ action: "accept", content: {} }); // no _meta invented
  });

  it("end to end (modern era): a roots result _meta reaches the server and an elicitation round completes", async () => {
    let seenRoots: unknown;
    let seenElicit: unknown;
    const mock = new MockMCPServer(
      {
        tools: [
          { name: "roots", handler: async (_a, ctx) => ((seenRoots = await ctx.listRoots()), { content: [] }) },
          { name: "elicit", handler: async (_a, ctx) => ((seenElicit = await ctx.elicit({ message: "m", requestedSchema: { type: "object", properties: {} } })), { content: [] }) },
        ],
      },
      { era: "modern" },
    );
    const client = new MCPClient({
      servers: { s: { transport: mock.transport, versionNegotiation: { mode: "auto" } } },
      handlers: { roots: () => ({ roots: [{ uri: "file:///w" }], _meta: { r: "x" } }), elicitation: async () => ({ action: "accept", content: {}, _meta: { e: "y" } }) },
    });
    await client.connect();
    await client.callTool("s.roots", {});
    await client.callTool("s.elicit", {});
    expect((seenRoots as { _meta?: unknown })._meta).toEqual({ r: "x" });
    // The elicitation round itself works. Whether the SDK 2.0.0 multi-round-trip driver keeps an ElicitResult
    // `_meta` on the wire is up to the SDK (the handler and broker return it; see the tests above), so it is
    // not asserted here.
    expect((seenElicit as { action?: string }).action).toBe("accept");
    await client.close();
  });
});
