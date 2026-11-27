// #58: governed mode — an app-initiated tool call that policy marks `approve` waits for a person.
import { describe, expect, it } from "vitest";
import { MCPClient } from "@johnhenry/mcp-query";
import { createAppHost } from "@johnhenry/mcp-query-ui";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { Governance, approvePolicy, globMatches, parsePatterns } from "../src/lib/governed.js";

const URI = "ui://demo/app";
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | undefined, ms = 2000): Promise<T> {
  for (let i = 0; i < ms / 5; i++) {
    const v = f();
    if (v) return v;
    await tick(5);
  }
  throw new Error("timed out");
}

function mock() {
  let n = 0;
  return new MockMCPServer({
    tools: [
      { name: "show", _meta: { ui: { resourceUri: URI } }, handler: () => ({ content: [{ type: "text", text: "shown" }] }) },
      { name: "next_count", _meta: { ui: { resourceUri: URI, visibility: ["app"] } }, handler: () => ({ content: [{ type: "text", text: String(++n) }] }) },
    ],
    resources: [{ uri: URI, name: "app", mimeType: "text/html;profile=mcp-app", read: () => ({ text: "<p>app</p>" }) }],
  });
}

describe("approve policy", () => {
  it("approves only tool calls whose server.tool id matches; reads and lists are allowed", () => {
    const p = approvePolicy(() => ["demo.next_*"]);
    const base = { server: "demo", destructive: false, readOnly: false } as never;
    expect(p({ ...base, kind: "call", target: "next_count" })).toBe("approve");
    expect(p({ ...base, kind: "call", target: "show" })).toBe("allow");
    expect(p({ ...base, kind: "read", target: URI })).toBe("allow");
    expect(p({ ...base, kind: "list", target: "tools" })).toBe("allow");
  });

  it("globs and the pattern box parse as documented", () => {
    expect(globMatches("*", "a.b")).toBe(true);
    expect(globMatches("a.*", "b.c")).toBe(false);
    expect(globMatches("a.b.c", "aXbXc")).toBe(false); // dots are literal
    expect(parsePatterns(" demo.a,demo.b  \n *.c ")).toEqual(["demo.a", "demo.b", "*.c"]);
  });
});

/** The inspector's wiring in miniature: ONE client, the governance interceptor on it, an app host with the governance context. */
async function setup(patterns: string[]) {
  const m = mock();
  const g = new Governance();
  g.setPatterns(patterns);
  const client = new MCPClient({ servers: { demo: { transport: m.transport } }, interceptors: [g.interceptor] });
  await client.connect();
  const host = createAppHost({ client, server: "demo", context: g.context });
  const appCall = (tool: string, uri = URI) => client.callTool(tool, {}, { server: "demo", context: { meta: { principal: `mcp-app:${uri}`, governed: g.isGoverned(uri) } } });
  return { m, g, client, host, appCall, done: async () => { await host.closeAll(); await client.close(); await m.close(); } };
}
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe("Governance (governed mode, single connection)", () => {
  it("parks a governed app call as a pending approval and resolves it on Approve; the server was connected once", async () => {
    const { g, client, appCall, done } = await setup(["demo.next_count"]);
    g.setGoverned(URI, true);
    expect(client.connections().map((c) => c.name)).toEqual(["demo"]);
    const call = appCall("next_count");
    const pending = await until(() => g.pending()[0]);
    expect(pending).toMatchObject({ server: "demo", kind: "call", target: "next_count", principal: `mcp-app:${URI}` });
    let settled = false;
    void call.then(() => (settled = true), () => (settled = true));
    expect(settled).toBe(false); // parked in the broker until a person decides
    g.decide(pending.key, "approve");
    expect(text(await call)).toBe("1");
    expect(g.pending()).toEqual([]);
    await done();
  });

  it("the app host's own calls are governed through the context callback; reading the app resource is never held", async () => {
    const { g, host, done } = await setup(["*"]);
    g.setGoverned(URI, true);
    const session = await host.open({ tool: "show" }); // resources/read (+ lists): not held
    expect(g.pending()).toEqual([]);
    const bridge = session.bridge as unknown as { oncalltool: (p: { name: string; arguments?: object }) => Promise<unknown> };
    const call = bridge.oncalltool({ name: "next_count", arguments: {} }); // what the app's tools/call lands on
    const pending = await until(() => g.pending()[0]);
    expect(pending.principal).toBe(`mcp-app:${URI}`);
    g.decide(pending.key, "deny");
    await expect(call).rejects.toThrow(/denied/);
    expect(session.getState().calls.at(-1)).toMatchObject({ kind: "tool", target: "next_count", outcome: "denied" });
    await done();
  });

  it("Deny refuses the call and the tool never ran", async () => {
    const { g, client, appCall, done } = await setup(["*"]);
    g.setGoverned(URI, true);
    const settled = appCall("next_count").then(() => "ok", (e: Error) => e.message);
    g.decide((await until(() => g.pending()[0])).key, "deny");
    expect(await settled).toMatch(/denied/);
    g.setGoverned(URI, false);
    expect(text(await appCall("next_count"))).toBe("1"); // the denied call did not bump the counter
    expect(client.connections()).toHaveLength(1);
    await done();
  });

  it("only governed app calls are held: the rest of the inspector, ungoverned apps and unmatched tools pass untouched", async () => {
    const { g, client, appCall, done } = await setup(["*"]);
    // no principal at all (Tools tab): not held even though the pattern is `*`
    expect(text(await client.callTool("show", {}, { server: "demo" }))).toBe("shown");
    // an app principal, but the app was opened ungoverned
    expect(text(await appCall("show", "ui://other"))).toBe("shown");
    // a governed principal on a call the patterns do not match
    g.setPatterns(["demo.next_count"]);
    g.setGoverned(URI, true);
    expect(text(await appCall("show"))).toBe("shown");
    // a governed app's resource read and catalog views are not calls
    await client.readResource(URI, { server: "demo", context: { meta: { principal: `mcp-app:${URI}`, governed: true } } });
    await client.discover("resources", "demo", { context: { meta: { principal: `mcp-app:${URI}`, governed: true } } });
    expect(client.listTools("demo").map((t) => t.name).sort()).toEqual(["next_count", "show"]); // catalog view intact
    expect(g.pending()).toEqual([]);
    await done();
  });

  it("denyFor refuses a closed app's waiting calls, closeServer refuses the rest", async () => {
    const { g, appCall, done } = await setup(["demo.next_count"]);
    g.setGoverned("ui://a", true);
    const a = appCall("next_count", "ui://a").then(() => "ok", () => "refused");
    await until(() => g.pending()[0]);
    g.denyFor("demo", "mcp-app:ui://other"); // a different app: untouched
    expect(g.pending()).toHaveLength(1);
    g.denyFor("demo", "mcp-app:ui://a");
    expect(await a).toBe("refused");

    const b = appCall("next_count", "ui://a").then(() => "ok", () => "refused");
    await until(() => g.pending()[0]);
    g.closeServer("other"); // another server: untouched
    expect(g.pending()).toHaveLength(1);
    g.closeServer("demo");
    expect(await b).toBe("refused");
    expect(g.pending()).toEqual([]);
    await done();
  });

  it("notifies subscribers when an approval appears and is decided", async () => {
    const { g, appCall, done } = await setup(["demo.next_count"]);
    g.setGoverned(URI, true);
    let n = 0;
    g.subscribe(() => n++);
    const call = appCall("next_count");
    g.decide((await until(() => g.pending()[0])).key, "approve");
    await call;
    expect(n).toBeGreaterThan(0);
    await done();
  });
});
