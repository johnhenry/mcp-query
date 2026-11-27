import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionBroker } from "@johnhenry/mcp-query";
import { APP_URI, makeFixture } from "./fixture.js";

let fx: Awaited<ReturnType<typeof makeFixture>> | undefined;
afterEach(async () => {
  await fx?.close();
  fx = undefined;
});

// Result schema stand-in so the test needs no direct zod dependency.
const anyResult = { parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }), "~standard": { version: 1, vendor: "test", validate: (v: unknown) => ({ value: v }) } } as never;

const echoModel = async (req: unknown) => ({
  role: "assistant" as const,
  content: { type: "text" as const, text: `MODEL:${JSON.stringify((req as { messages: unknown }).messages)}` },
  model: "fake",
  stopReason: "endTurn",
});
const sampleReq = { messages: [{ role: "user" as const, content: { type: "text" as const, text: "hello" } }], maxTokens: 10 };

describe("opt-in app capabilities are OFF by default", () => {
  it("refuses resources/list, prompts/list, sampling and update-model-context with a clear error, and records each as denied", async () => {
    fx = await makeFixture();
    const { app, session } = await fx.openAndConnect();
    await expect(app.listServerResources()).rejects.toThrow(/resources\/list is not enabled for apps.*appCapabilities\.resourcesList/);
    await expect(app.request({ method: "prompts/list", params: {} }, anyResult)).rejects.toThrow(/prompts\/list is not enabled.*appCapabilities\.promptsList/);
    await expect(app.createSamplingMessage(sampleReq)).rejects.toThrow(/sampling\/createMessage is not enabled.*appCapabilities\.sampling/);
    await expect(app.updateModelContext({ content: [{ type: "text", text: "x" }] })).rejects.toThrow(/ui\/update-model-context is not enabled.*appCapabilities\.updateModelContext/);
    expect(session.getState().calls.map((c) => [c.kind, c.target, c.outcome])).toEqual([
      ["resources-list", "resources/list", "denied"],
      ["prompts-list", "prompts/list", "denied"],
      ["sampling", "sampling/createMessage", "denied"],
      ["model-context", "ui/update-model-context", "denied"],
    ]);
    // nothing was advertised to the app either
    expect(app.getHostCapabilities()).not.toHaveProperty("sampling");
    expect(app.getHostCapabilities()).not.toHaveProperty("updateModelContext");
  });

  it("each capability is independent: enabling one leaves the others refused", async () => {
    fx = await makeFixture({}, { appCapabilities: { resourcesList: true } });
    const { app } = await fx.openAndConnect();
    expect((await app.listServerResources()).resources.map((r) => r.uri)).toContain(APP_URI);
    await expect(app.request({ method: "prompts/list", params: {} }, anyResult)).rejects.toThrow(/not enabled/);
  });

  it("enabling sampling without a broker, or model-context without a handler, fails fast at createAppHost", async () => {
    await expect(makeFixture({}, { appCapabilities: { sampling: true } })).rejects.toThrow(/InteractionBroker/);
    await expect(makeFixture({}, { appCapabilities: { updateModelContext: true } })).rejects.toThrow(/onUpdateModelContext/);
  });
});

describe("resources/list and prompts/list when opted in", () => {
  it("serve the client's lists and are recorded in state.calls like tool calls", async () => {
    fx = await makeFixture({}, { appCapabilities: { resourcesList: true, promptsList: true } }, { prompts: true });
    const { app, session } = await fx.openAndConnect();
    const res = await app.listServerResources();
    expect(res.resources.map((r) => r.uri).sort()).toEqual([APP_URI, "file:///data.txt", "ui://demo/not-html"].sort());
    const prompts = (await app.request({ method: "prompts/list", params: {} }, anyResult)) as { prompts: Array<{ name: string }> };
    expect(prompts.prompts.map((p) => p.name)).toEqual(["greet"]);
    expect(session.getState().calls.map((c) => [c.kind, c.outcome])).toEqual([
      ["resources-list", "ok"],
      ["prompts-list", "ok"],
    ]);
  });

  it("go through the host's broker policy as `confirm` interactions filed under the app principal; a denial is refused and recorded", async () => {
    const policy = vi.fn((ctx: { server: string; type: string; payload: unknown }) => (ctx.payload && (ctx.payload as { method: string }).method === "prompts/list" ? ("deny" as const) : ("allow" as const)));
    const interactions = new InteractionBroker({ policy });
    fx = await makeFixture({}, { appCapabilities: { resourcesList: true, promptsList: true }, interactions }, { prompts: true });
    const { app, session } = await fx.openAndConnect();
    await app.listServerResources();
    await expect(app.request({ method: "prompts/list", params: {} }, anyResult)).rejects.toThrow(/denied/);
    expect(policy.mock.calls.map((c) => [c[0].server, c[0].type, (c[0].payload as { method: string }).method])).toEqual([
      [`mcp-app:${APP_URI}`, "confirm", "resources/list"],
      [`mcp-app:${APP_URI}`, "confirm", "prompts/list"],
    ]);
    expect(session.getState().calls.map((c) => c.outcome)).toEqual(["ok", "denied"]);
  });

  it("a human can hold the request: it stays pending until the broker is resolved", async () => {
    const interactions = new InteractionBroker(); // default policy: ask
    fx = await makeFixture({}, { appCapabilities: { resourcesList: true }, interactions });
    const { app, session } = await fx.openAndConnect();
    const p = app.listServerResources();
    await fx.tick(50);
    expect(session.getState().calls[0]).toMatchObject({ outcome: "pending" });
    interactions.resolve(interactions.list()[0]!.id, { action: "approve" });
    expect((await p).resources.length).toBeGreaterThan(0);
  });
});

describe("resources/list and prompts/list run through the client's interceptor chain (#90)", () => {
  it("an mcp-gate policy sees each app list as a `list` operation for the app principal, and its audit records it", async () => {
    const seen: Array<{ kind: string; target: string; principal: unknown }> = [];
    fx = await makeFixture(
      {
        policy: (req) => {
          const principal = (req.context?.meta as { principal?: string } | undefined)?.principal;
          if (principal?.startsWith("mcp-app:")) seen.push({ kind: req.kind, target: req.target, principal });
          return req.kind === "list" && req.target === "prompts" && principal?.startsWith("mcp-app:") ? "deny" : "allow";
        },
      },
      { appCapabilities: { resourcesList: true, promptsList: true } },
      { prompts: true },
    );
    const { app, session } = await fx.openAndConnect();
    expect((await app.listServerResources()).resources.map((r) => r.uri)).toContain(APP_URI);
    await expect(app.request({ method: "prompts/list", params: {} }, anyResult)).rejects.toThrow(/denied/);
    expect(seen.filter((o) => o.kind === "list")).toEqual([
      { kind: "list", target: "resources", principal: `mcp-app:${APP_URI}` },
      { kind: "list", target: "prompts", principal: `mcp-app:${APP_URI}` },
    ]);
    expect(session.getState().calls.map((c) => [c.kind, c.outcome])).toEqual([
      ["resources-list", "ok"],
      ["prompts-list", "denied"],
    ]);
    const entries = fx.audit.mock.calls.map((c) => c[0] as { kind: string; target: string; principal?: string; outcome: string });
    expect(entries.filter((e) => e.kind === "list" && e.principal === `mcp-app:${APP_URI}`).map((e) => [e.target, e.outcome])).toEqual([
      ["resources", "ok"],
      ["prompts", "denied"],
    ]);
  });

  it("a gate deny glob hides the item from the app's list too", async () => {
    fx = await makeFixture({ policy: { deny: ["demo.file:///data.txt"] } }, { appCapabilities: { resourcesList: true } });
    const { app } = await fx.openAndConnect();
    expect((await app.listServerResources()).resources.map((r) => r.uri)).not.toContain("file:///data.txt");
  });

  it("the broker gate still runs first (a human can hold the request) and the lists stay off by default", async () => {
    fx = await makeFixture({ policy: () => "allow" });
    const { app } = await fx.openAndConnect();
    await expect(app.listServerResources()).rejects.toThrow(/not enabled/);
  });
});

describe("sampling (opt-in, discouraged: deprecated in core, SEP-2577)", () => {
  it("runs through the InteractionBroker: policy sees `sampling` for the app peer, then the model answers", async () => {
    const policy = vi.fn(() => "allow" as const);
    const interactions = new InteractionBroker({ model: echoModel, policy });
    fx = await makeFixture({}, { appCapabilities: { sampling: true }, interactions });
    const { app, session } = await fx.openAndConnect();
    expect(app.getHostCapabilities()).toHaveProperty("sampling");
    const r = await app.createSamplingMessage(sampleReq);
    expect(JSON.stringify(r.content)).toContain("MODEL:");
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ server: `mcp-app:${APP_URI}`, type: "sampling" }));
    expect(interactions.auditLog().map((e) => [e.peer, e.type, e.outcome])).toEqual([[`mcp-app:${APP_URI}`, "sampling", "auto-allow"]]);
    expect(session.getState().calls[0]).toMatchObject({ kind: "sampling", target: "sampling/createMessage", outcome: "ok" });
  });

  it("falls back to client.interactions, and a deny verdict refuses the request", async () => {
    const interactions = new InteractionBroker({ model: echoModel, policy: () => "deny" });
    fx = await makeFixture({}, { appCapabilities: { sampling: true }, interactions });
    const { app, session } = await fx.openAndConnect();
    await expect(app.createSamplingMessage(sampleReq)).rejects.toThrow(/denied/);
    expect(session.getState().calls[0]).toMatchObject({ kind: "sampling", outcome: "denied" });
  });

  it("with no model configured the request fails (it is never auto-answered)", async () => {
    const interactions = new InteractionBroker({ policy: () => "allow" });
    fx = await makeFixture({}, { appCapabilities: { sampling: true }, interactions });
    const { app, session } = await fx.openAndConnect();
    await expect(app.createSamplingMessage(sampleReq)).rejects.toThrow(/no sampling model/);
    expect(session.getState().calls[0]).toMatchObject({ outcome: "error" });
  });
});

describe("ui/update-model-context (opt-in)", () => {
  it("delivers approved context to onUpdateModelContext and records it", async () => {
    const onUpdateModelContext = vi.fn();
    fx = await makeFixture({}, { appCapabilities: { updateModelContext: true }, onUpdateModelContext });
    const { app, session } = await fx.openAndConnect();
    expect(app.getHostCapabilities()).toHaveProperty("updateModelContext");
    await app.updateModelContext({ content: [{ type: "text", text: "state" }], structuredContent: { n: 1 } });
    expect(onUpdateModelContext).toHaveBeenCalledWith({ content: [{ type: "text", text: "state" }], structuredContent: { n: 1 } }, { id: session.id, uri: APP_URI });
    expect(session.getState().calls[0]).toMatchObject({ kind: "model-context", target: "ui/update-model-context", outcome: "ok" });
  });

  it("is approved by the broker first: a denial never reaches the handler", async () => {
    const onUpdateModelContext = vi.fn();
    const interactions = new InteractionBroker({ policy: () => "deny" });
    fx = await makeFixture({}, { appCapabilities: { updateModelContext: true }, onUpdateModelContext, interactions });
    const { app, session } = await fx.openAndConnect();
    await expect(app.updateModelContext({ content: [{ type: "text", text: "x" }] })).rejects.toThrow(/denied/);
    expect(onUpdateModelContext).not.toHaveBeenCalled();
    expect(session.getState().calls[0]).toMatchObject({ outcome: "denied" });
  });

  it("the handler can refuse by throwing", async () => {
    fx = await makeFixture({}, { appCapabilities: { updateModelContext: true }, onUpdateModelContext: () => { throw new Error("nope"); } });
    const { app, session } = await fx.openAndConnect();
    await expect(app.updateModelContext({ content: [] })).rejects.toThrow(/nope/);
    expect(session.getState().calls[0]).toMatchObject({ outcome: "error", error: "nope" });
  });
});
