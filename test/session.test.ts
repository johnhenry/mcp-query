import { describe, it, expect, vi } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { SessionManager } from "../src/session/index.js";

function makeClient() {
  const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] });
  return { mock, build: async () => { const c = new MCPClient({ servers: { s: { transport: mock.transport } } }); await c.connect(); return c; } };
}

describe("client.drain", () => {
  it("refuses new ops after draining and closes connections", async () => {
    const { build } = makeClient();
    const client = await build();
    await client.callTool("s.echo", { msg: "a" }); // works before drain
    await client.drain();
    await expect(client.callTool("s.echo", { msg: "b" })).rejects.toThrow(/draining/);
    expect(client.serverState("s")).toBe("closed");
  });
});

describe("client.health", () => {
  it("reports per-server state + a live ping", async () => {
    const { build } = makeClient();
    const client = await build();
    const h = await client.health();
    expect(h.s).toMatchObject({ state: "ready", ok: true });
    expect(typeof h.s!.pingMs).toBe("number");
    await client.close();
  });
});

describe("SessionManager", () => {
  it("creates one client per principal and reuses it", async () => {
    const create = vi.fn(async (p: string) => makeClient().build().then((c) => c));
    const mgr = new SessionManager({ create });
    const a1 = await mgr.get("alice");
    const a2 = await mgr.get("alice");
    const b1 = await mgr.get("bob");
    expect(a1).toBe(a2); // reused
    expect(a1).not.toBe(b1); // isolated
    expect(create).toHaveBeenCalledTimes(2);
    expect(mgr.size()).toBe(2);
    await mgr.closeAll();
    expect(mgr.size()).toBe(0);
  });

  it("evicts idle sessions on sweep (draining them)", async () => {
    let t = 1000;
    const built: MCPClient[] = [];
    const mgr = new SessionManager({
      now: () => t,
      ttl: 100,
      create: async () => { const c = await makeClient().build(); built.push(c); return c; },
    });
    await mgr.get("alice");
    t = 1050;
    await mgr.sweep(); // within ttl — kept
    expect(mgr.size()).toBe(1);
    t = 1200;
    await mgr.sweep(); // idle past ttl — evicted + drained
    expect(mgr.size()).toBe(0);
    expect(built[0]!.serverState("s")).toBe("closed");
  });
});
