import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { APP_URI, makeFixture } from "./fixture.js";
import { MCP_APPS_EXTENSION_ID, mcpAppsExtensions } from "../src/index.js";

let fx: Awaited<ReturnType<typeof makeFixture>> | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

describe("mount: resource load through the client", () => {
  it("reads the ui:// resource via MCPClient and derives sandbox/CSP info from its _meta", async () => {
    fx = await makeFixture();
    const session = await fx.host.open({ uri: APP_URI });
    expect(session.getState()).toMatchObject({ status: "loaded", uri: APP_URI, server: "demo" });
    expect(session.resource.html).toContain("demo app");
    expect(session.resource.csp).toEqual({ connectDomains: ["https://api.example.com"], resourceDomains: ["https://cdn.example.com"] });
    expect(session.resource.cspHeader).toContain("connect-src 'self' https://api.example.com");
    expect(session.resource.cspHeader).toContain("frame-src 'none'");
    expect(session.resource.cspHeader).toContain("object-src 'none'");
    expect(session.resource.allow).toBe("camera");
    // the read went through the client (gate audit sees it) and is cached
    await fx.tick();
    expect(fx.audit.mock.calls.map((c) => [c[0].kind, c[0].target])).toContainEqual(["read", APP_URI]);
  });

  it("resolves the app from a tool's _meta.ui.resourceUri", async () => {
    fx = await makeFixture();
    const session = await fx.host.open({ tool: "show_app" });
    expect(session.getState().uri).toBe(APP_URI);
    await expect(fx.host.open({ tool: "nope" })).rejects.toThrow(/unknown tool/);
  });

  it("rejects non-ui:// URIs, non-app MIME types and unknown resources (nothing is mounted)", async () => {
    fx = await makeFixture();
    await expect(fx.host.open({ uri: "file:///data.txt" })).rejects.toThrow(/ui:\/\//);
    await expect(fx.host.open({ uri: "ui://demo/not-html" })).rejects.toThrow(/mcp-app/);
    await expect(fx.host.open({ uri: "ui://demo/missing" })).rejects.toThrow();
    expect(fx.host.getSessions()).toHaveLength(0);
  });

  it("drops CSP sources that could inject directives (no loosening via hostile metadata)", async () => {
    const mock = new MockMCPServer({
      resources: [{ uri: "ui://x/evil", mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: ["https://ok.example.com", "https://a.com; script-src *", "'unsafe-eval'", "*"] } } }, read: () => ({ text: "<p/>" }) }],
    });
    const client = new MCPClient({ servers: { x: { transport: mock.transport } } });
    await client.connect();
    const { createAppHost } = await import("../src/index.js");
    const session = await createAppHost({ client, server: "x" }).open({ uri: "ui://x/evil" });
    expect(session.resource.csp.connectDomains).toEqual(["https://ok.example.com"]);
    expect(session.resource.cspHeader).not.toContain("script-src *");
    await client.close();
  });

  it("host allowDomain can narrow what the app asked for", async () => {
    fx = await makeFixture({}, { allowDomain: (d) => !d.includes("cdn.") });
    const s = await fx.host.open({ uri: APP_URI });
    expect(s.resource.csp.resourceDomains).toEqual([]);
    expect(s.resource.csp.connectDomains).toEqual(["https://api.example.com"]);
  });
});

describe("lifecycle + reactive state", () => {
  it("connect -> ready: delivers tool input/result after the View's initialized and notifies subscribers", async () => {
    fx = await makeFixture();
    const seen: string[] = [];
    const session = await fx.host.open({ uri: APP_URI, toolInput: { q: 1 }, toolResult: { content: [{ type: "text", text: "r" }] } });
    session.subscribe(() => seen.push(session.getState().status));
    const snap0 = session.getState();
    const { App } = await import("@modelcontextprotocol/ext-apps");
    const { InMemoryTransport } = await import("@modelcontextprotocol/client");
    const [hostT, viewT] = InMemoryTransport.createLinkedPair();
    const app = new App({ name: "v", version: "1" }, {}, { autoResize: false });
    const input = new Promise((r) => (app.ontoolinput = (p) => r(p)));
    const result = new Promise((r) => (app.ontoolresult = (p) => r(p)));
    await session.connect(hostT);
    await app.connect(viewT);
    expect(await input).toMatchObject({ arguments: { q: 1 } });
    expect(await result).toMatchObject({ content: [{ type: "text", text: "r" }] });
    await session.whenReady(2000);
    expect(seen).toContain("connecting");
    expect(session.getState().status).toBe("ready");
    expect(session.getState().appInfo).toMatchObject({ name: "v" });
    expect(session.getState()).not.toBe(snap0); // immutable snapshots (useSyncExternalStore-safe)
    expect(fx.host.getSessions()).toContain(session);
  });

  it("teardown: close() tells the View, goes closed, is idempotent, and untracks the session", async () => {
    fx = await makeFixture();
    const { session, app } = await fx.openAndConnect();
    const tornDown = vi.fn(() => ({}));
    app.onteardown = tornDown;
    await session.close();
    expect(tornDown).toHaveBeenCalledTimes(1);
    expect(session.getState().status).toBe("closed");
    await session.close(); // idempotent
    expect(fx.host.getSessions()).not.toContain(session);
    await expect(session.connect({} as never)).rejects.toThrow(/closed/);
  });

  it("the View can request teardown; cleanup callbacks run", async () => {
    fx = await makeFixture();
    const { session, app } = await fx.openAndConnect();
    const cleanup = vi.fn();
    session.addCleanup(cleanup);
    await app.requestTeardown();
    await vi.waitFor(() => expect(session.getState().status).toBe("closed"));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("ui/message lands in state.messages and onMessage; size changes are tracked", async () => {
    const onMessage = vi.fn(() => ({}));
    fx = await makeFixture({}, { onMessage });
    const { session, app } = await fx.openAndConnect();
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: "hello host" }] });
    expect(r.isError).toBeFalsy();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(session.getState().messages).toHaveLength(1);
    expect(session.getState().messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "hello host" }] });
    await app.sendSizeChanged({ width: 300, height: 120 });
    await vi.waitFor(() => expect(session.getState().size).toEqual({ width: 300, height: 120 }));
  });

  it("ui/open-link is refused unless the host opts in, and only for http(s)", async () => {
    fx = await makeFixture();
    const a = await fx.openAndConnect();
    expect((await a.app.openLink({ url: "https://example.com" })).isError).toBe(true);
    await fx.close();

    const onOpenLink = vi.fn(() => true);
    fx = await makeFixture({}, { onOpenLink });
    const b = await fx.openAndConnect();
    expect((await b.app.openLink({ url: "https://example.com/x" })).isError).toBeFalsy();
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/x", expect.anything());
    expect((await b.app.openLink({ url: "javascript:alert(1)" })).isError).toBe(true);
    expect(onOpenLink).toHaveBeenCalledTimes(1);
  });
});

describe("app-initiated tool calls run under the gate", () => {
  it("allow: reaches the upstream through MCPClient, is recorded in state and audited with the app principal", async () => {
    fx = await makeFixture({ policy: { allow: ["demo.save", "demo.refresh", "demo.ui://demo/app"] } });
    const { session, app } = await fx.openAndConnect();
    const res = await app.callServerTool({ name: "save", arguments: { doc: 1 } });
    expect(res.content[0]).toMatchObject({ text: "save:ok" });
    expect(fx.ran).toEqual([{ tool: "save", args: { doc: 1 } }]);
    expect(session.getState().calls[0]).toMatchObject({ kind: "tool", target: "save", outcome: "ok" });
    await fx.tick();
    const entry = fx.audit.mock.calls.map((c) => c[0]).find((e) => e.kind === "call");
    expect(entry).toMatchObject({ server: "demo", target: "save", outcome: "ok", principal: `mcp-app:${APP_URI}` });
  });

  it("app-only tools are callable by the app; model-only tools are rejected before reaching the client", async () => {
    fx = await makeFixture();
    const { app } = await fx.openAndConnect();
    expect((await app.callServerTool({ name: "refresh", arguments: {} })).content[0]).toMatchObject({ text: "refresh:ok" });
    await expect(app.callServerTool({ name: "model_only", arguments: {} })).rejects.toThrow(/not callable by apps/);
    await expect(app.callServerTool({ name: "ghost", arguments: {} })).rejects.toThrow(/unknown tool/);
    expect(fx.ran.map((r) => r.tool)).toEqual(["refresh"]);
    await fx.tick();
    expect(fx.audit.mock.calls.map((c) => c[0].target)).not.toContain("model_only");
  });

  it("policy deny: the call never reaches the upstream and is recorded as denied", async () => {
    fx = await makeFixture({ policy: { deny: ["demo.save"] } });
    const { session, app } = await fx.openAndConnect();
    await expect(app.callServerTool({ name: "save", arguments: {} })).rejects.toThrow(/denied|not allowed|unauthorized/i);
    expect(fx.ran).toEqual([]);
    expect(session.getState().calls[0]).toMatchObject({ target: "save", outcome: "denied" });
    await fx.tick();
    expect(fx.audit.mock.calls.map((c) => c[0].outcome)).toContain("denied");
  });

  it("approve: handler allow runs the tool; handler deny blocks it (approval carries the app principal)", async () => {
    let answer: "allow" | "deny" = "allow";
    const handler = vi.fn(async () => answer);
    fx = await makeFixture({ policy: { approve: ["demo.save"] }, approval: { handler } });
    const { session, app } = await fx.openAndConnect();
    expect((await app.callServerTool({ name: "save", arguments: { n: 1 } })).content[0]).toMatchObject({ text: "save:ok" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0] as unknown as [{ target: string; context?: { meta?: { principal?: string } } }])[0]).toMatchObject({
      target: "save",
      context: { meta: { principal: `mcp-app:${APP_URI}` } },
    });
    answer = "deny";
    await expect(app.callServerTool({ name: "save", arguments: { n: 2 } })).rejects.toThrow(/not approved/);
    expect(fx.ran).toEqual([{ tool: "save", args: { n: 1 } }]);
    expect(session.getState().calls.map((c) => c.outcome)).toEqual(["ok", "denied"]);
  });

  it("approve with no handler parks the call in gate.approvals until a human resolves it", async () => {
    fx = await makeFixture({ policy: { approve: ["demo.save"] }, approval: {} });
    const { session, app } = await fx.openAndConnect();
    const p = app.callServerTool({ name: "save", arguments: {} });
    await fx.tick(60);
    expect(fx.ran).toEqual([]);
    expect(session.getState().calls[0]).toMatchObject({ outcome: "pending" });
    const [pending] = fx.gate.approvals!.list();
    fx.gate.approvals!.resolve(pending!.id, { action: "approve" });
    expect((await p).content[0]).toMatchObject({ text: "save:ok" });
    expect(session.getState().calls[0]).toMatchObject({ outcome: "ok" });
  });
});

describe("app-initiated resource reads", () => {
  it("go through MCPClient.readResource (so the gate sees them) and return the SDK result", async () => {
    fx = await makeFixture();
    const { app } = await fx.openAndConnect();
    const r = await app.readServerResource({ uri: "file:///data.txt" });
    expect(r.contents[0]).toMatchObject({ uri: "file:///data.txt", text: "data" });
    await fx.tick();
    expect(fx.audit.mock.calls.map((c) => [c[0].kind, c[0].target, c[0].principal])).toContainEqual(["read", "file:///data.txt", `mcp-app:${APP_URI}`]);
  });

  it("policy applies to app reads too", async () => {
    fx = await makeFixture({ policy: { deny: ["demo.file:///data.txt"] } });
    const { app, session } = await fx.openAndConnect();
    await expect(app.readServerResource({ uri: "file:///data.txt" })).rejects.toThrow();
    expect(session.getState().calls.at(-1)).toMatchObject({ kind: "resource", target: "file:///data.txt", outcome: "denied" });
  });
});

describe("capability negotiation", () => {
  it("mcpAppsExtensions() opts an MCPClient into io.modelcontextprotocol/ui", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t", handler: () => ({ content: [] }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } }, extensions: mcpAppsExtensions() });
    await client.connect();
    await client.callTool("t", {});
    expect(MCP_APPS_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(mock.clientCapabilities()?.extensions?.[MCP_APPS_EXTENSION_ID]).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
    await client.close();
  });
});
