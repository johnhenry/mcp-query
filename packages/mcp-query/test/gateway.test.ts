import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { createGateway } from "../src/server/gateway.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const a = new MockMCPServer({
    tools: [{ name: "echo", handler: (x) => ({ content: [{ type: "text", text: String(x.msg) }] }) }],
    resources: [{ uri: "a://doc", read: () => ({ text: "AAA" }) }],
  });
  const b = new MockMCPServer({
    tools: [{ name: "ping", handler: () => ({ content: [{ type: "text", text: "pong" }] }) }],
    prompts: [{ name: "hello", get: () => ({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] }) }],
  });
  const upstream = new MCPClient({ servers: { a: { transport: a.transport }, b: { transport: b.transport } } });
  await upstream.connect();

  const gateway = createGateway(upstream);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverT);
  const consumer = new Client({ name: "consumer", version: "1" }, { capabilities: {} });
  await consumer.connect(clientT);
  return { upstream, gateway, consumer, a, b };
}

describe("createGateway", () => {
  it("aggregates + namespaces tools and routes calls to the right upstream", async () => {
    const { consumer } = await setup();
    const names = (await consumer.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["a.echo", "b.ping"]);

    const echo = (await consumer.callTool({ name: "a.echo", arguments: { msg: "via-gw" } })) as { content: { text: string }[] };
    expect(echo.content[0]!.text).toBe("via-gw");
    const pong = (await consumer.callTool({ name: "b.ping", arguments: {} })) as { content: { text: string }[] };
    expect(pong.content[0]!.text).toBe("pong");
  });

  it("aggregates resources and prompts, and routes read/get", async () => {
    const { consumer } = await setup();
    expect((await consumer.listResources()).resources.map((r) => r.uri)).toContain("a://doc");
    const doc = (await consumer.readResource({ uri: "a://doc" })) as { contents: { text: string }[] };
    expect(doc.contents[0]!.text).toBe("AAA");

    expect((await consumer.listPrompts()).prompts.map((p) => p.name)).toContain("b.hello");
    const prompt = await consumer.getPrompt({ name: "b.hello", arguments: {} });
    expect(prompt.messages).toHaveLength(1);
  });

  it("forwards the caller's _meta through to the upstream tool (tenant/principal propagation)", async () => {
    const seen: unknown[] = [];
    const meta = new MockMCPServer({
      tools: [
        {
          name: "whoami",
          handler: (_a, ctx) => {
            seen.push(ctx.meta);
            return { content: [{ type: "text", text: String((ctx.meta as { tenant?: string })?.tenant ?? "anon") }] };
          },
        },
      ],
    });
    const upstream = new MCPClient({ servers: { m: { transport: meta.transport } } });
    await upstream.connect();
    const gateway = createGateway(upstream);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await gateway.connect(serverT);
    const consumer = new Client({ name: "consumer", version: "1" }, { capabilities: {} });
    await consumer.connect(clientT);

    const out = (await consumer.callTool({ name: "m.whoami", arguments: {}, _meta: { tenant: "acme" } })) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0]!.text).toBe("acme");
    expect(seen[0]).toMatchObject({ tenant: "acme" });
  });

  it("propagates upstream list_changed to the gateway consumer", async () => {
    const { consumer, b } = await setup();
    let notified = false;
    consumer.setNotificationHandler(
      "notifications/tools/list_changed",
      () => { notified = true; },
    );
    b.spec.tools = [{ name: "ping" }, { name: "ping2" }];
    await b.notifyToolListChanged();
    await tick(30);
    expect(notified).toBe(true);
    expect((await consumer.listTools()).tools.map((t) => t.name)).toContain("b.ping2");
  });

  it("doesn't reject/crash on a capability change when its server was never connected to a transport (library mode)", async () => {
    // createGateway's `server` is optional — a caller can use `client` directly and never
    // connect `server` to any transport at all (mcp-gate's "library mode"). A capability
    // change must not throw "not connected" in that case; it has nowhere to notify, so it
    // should just no-op. Regression test: this used to be an unhandled rejection (vitest
    // fails a test with one in flight), because the internal `subscribeCapabilities`
    // callback called `server.sendToolListChanged()` with no error handling at all.
    const b = new MockMCPServer({ tools: [{ name: "ping" }] });
    const upstream = new MCPClient({ servers: { b: { transport: b.transport } } });
    await upstream.connect();
    createGateway(upstream); // server intentionally never connected to a transport
    b.spec.tools = [{ name: "ping" }, { name: "ping2" }];
    await b.notifyToolListChanged();
    await tick(30); // let the async subscribeCapabilities callback settle
    expect(upstream.listTools("b").map((t) => t.name)).toContain("ping2"); // the client itself still updated
  });
});
