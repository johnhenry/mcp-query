import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("lazy connect", () => {
  it("does not connect a lazy server until first use, then connects on demand", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] });
    const client = new MCPClient({ servers: { svc: { transport: mock.transport, lazy: true } } });

    await client.connect(); // eager phase — lazy server stays idle
    expect(client.serverState("svc")).toBe("idle");
    expect(mock.connectCount).toBe(0);

    // first namespaced call wakes it
    const r = (await client.callTool("svc.echo", { msg: "hi" })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("hi");
    expect(client.serverState("svc")).toBe("ready");
    expect(mock.connectCount).toBe(1);
    await client.close();
  });

  it("evicts after idle, then re-wakes on the next use", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }] });
    const client = new MCPClient({ servers: { svc: { transport: mock.transport, lazy: true, idleMs: 30 } } });
    await client.connect();

    await client.callTool("svc.echo", {}); // wake (connect #1)
    expect(client.serverState("svc")).toBe("ready");

    await tick(60); // idle past idleMs -> slept
    expect(client.serverState("svc")).toBe("idle");

    await client.callTool("svc.echo", {}); // re-wake (connect #2)
    expect(client.serverState("svc")).toBe("ready");
    expect(mock.connectCount).toBe(2);
    await client.close();
  });

  it("eager servers are unaffected (connect at client.connect())", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const client = new MCPClient({ servers: { svc: { transport: mock.transport } } }); // not lazy
    await client.connect();
    expect(client.serverState("svc")).toBe("ready");
    expect(mock.connectCount).toBe(1);
    await client.close();
  });
});
