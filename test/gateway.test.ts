import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

  it("propagates upstream list_changed to the gateway consumer", async () => {
    const { consumer, b } = await setup();
    let notified = false;
    consumer.setNotificationHandler(
      (await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema,
      () => { notified = true; },
    );
    b.spec.tools = [{ name: "ping" }, { name: "ping2" }];
    await b.notifyToolListChanged();
    await tick(30);
    expect(notified).toBe(true);
    expect((await consumer.listTools()).tools.map((t) => t.name)).toContain("b.ping2");
  });
});
