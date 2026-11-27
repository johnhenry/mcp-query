// #58: governed mode — an app-initiated tool call that policy marks `approve` waits for a person.
import { describe, expect, it } from "vitest";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { Governance, approvePolicy, globMatches, parsePatterns } from "../src/lib/governed.js";
import { hostFor } from "../src/lib/apps.js";

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

describe("Governance (governed mode)", () => {
  it("parks an app call as a pending approval and resolves it on Approve", async () => {
    const m = mock();
    const g = new Governance();
    g.setPatterns(["demo.next_count"]);
    const client = await g.clientFor("demo", new Map([["demo", { transport: m.transport }]]));
    const session = await hostFor(client, "demo").open({ tool: "show" }); // load: a resource read, never held
    expect(g.pending()).toEqual([]);

    // The app's tools/call goes through the host bridge to client.callTool with the app's principal.
    const call = client.callTool("next_count", {}, { server: "demo", context: { meta: { principal: `mcp-app:${URI}` } } });
    const pending = await until(() => g.pending()[0]);
    expect(pending).toMatchObject({ server: "demo", kind: "call", target: "next_count", principal: `mcp-app:${URI}` });
    let settled = false;
    void call.then(() => (settled = true), () => (settled = true));
    await tick(30);
    expect(settled).toBe(false); // held until a person decides

    g.decide(pending.key, "approve");
    const res = (await call) as { content: Array<{ text: string }> };
    expect(res.content[0]!.text).toBe("1");
    expect(g.pending()).toEqual([]);
    await session.close();
    await g.close("demo");
    await m.close();
  });

  it("Deny refuses the call (the app sees an error) and the tool never ran", async () => {
    const m = mock();
    const g = new Governance();
    g.setPatterns(["*"]);
    const client = await g.clientFor("demo", new Map([["demo", { transport: m.transport }]]));
    const call = client.callTool("next_count", {}, { server: "demo", context: { meta: { principal: `mcp-app:${URI}` } } });
    const settled = call.then(() => "ok", (e: Error) => e.message);
    g.decide((await until(() => g.pending()[0])).key, "deny");
    expect(await settled).toMatch(/denied/);
    // a later approved call proves the counter was not bumped by the denied one
    const next = client.callTool("next_count", {}, { server: "demo" });
    g.decide((await until(() => g.pending()[0])).key, "approve");
    expect(((await next) as { content: Array<{ text: string }> }).content[0]!.text).toBe("1");
    await g.close("demo");
    await m.close();
  });

  it("an unmatched call is not held, denyFor refuses a closed app's waiting calls, and close() refuses the rest", async () => {
    const m = mock();
    const g = new Governance();
    g.setPatterns(["demo.next_count"]);
    const client = await g.clientFor("demo", new Map([["demo", { transport: m.transport }]]));
    expect(((await client.callTool("show", {}, { server: "demo" })) as { content: Array<{ text: string }> }).content[0]!.text).toBe("shown");
    expect(g.pending()).toEqual([]);

    const ctx = { server: "demo", context: { meta: { principal: "mcp-app:ui://a" } } };
    const a = client.callTool("next_count", {}, ctx).then(() => "ok", () => "refused");
    await until(() => g.pending()[0]);
    g.denyFor("demo", "mcp-app:ui://other"); // a different app: untouched
    expect(g.pending()).toHaveLength(1);
    g.denyFor("demo", "mcp-app:ui://a");
    expect(await a).toBe("refused");

    const b = client.callTool("next_count", {}, ctx).then(() => "ok", () => "refused");
    await until(() => g.pending()[0]);
    await g.close("demo");
    expect(await b).toBe("refused");
    expect(g.pending()).toEqual([]);
    await m.close();
  });

  it("is lazy: nothing connects until clientFor is called, and an unknown server is an error", async () => {
    const g = new Governance();
    expect(g.pending()).toEqual([]);
    await expect(g.clientFor("nope", new Map())).rejects.toThrow(/no saved connection/);
  });

  it("notifies subscribers when an approval appears and is decided", async () => {
    const m = mock();
    const g = new Governance();
    let n = 0;
    g.subscribe(() => n++);
    const client = await g.clientFor("demo", new Map([["demo", { transport: m.transport }]]));
    const before = n;
    const call = client.callTool("next_count", {}, { server: "demo" });
    g.decide((await until(() => g.pending()[0])).key, "approve");
    await call;
    expect(n).toBeGreaterThan(before);
    await g.close("demo");
    await m.close();
  });
});
