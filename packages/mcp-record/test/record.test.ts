import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer } from "../../../src/testing/mockServer.js";
import { createCassette } from "../src/cassette.js";
import { recordTransport } from "../src/record.js";
import { replayServer, replayTransport } from "../src/replay.js";

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const resText = (r: { contents: unknown[] }) => (r.contents[0] as { text: string }).text;

async function connect(transport: () => ReturnType<MockMCPServer["transport"]>) {
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(transport());
  return client;
}

describe("record → replay", () => {
  it("captures a live session and replays it offline with identical results", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }],
      resources: [{ uri: "file:///a", name: "a", read: () => ({ text: "hello A" }) }],
      prompts: [{ name: "greet" }],
    });
    const cassette = createCassette();

    // ── record ──
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rec.connect(recordTransport(mock.transport(), cassette));
    expect((await rec.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(text(await rec.callTool({ name: "echo", arguments: { msg: "hi" } }))).toBe("hi");
    expect(resText(await rec.readResource({ uri: "file:///a" }))).toBe("hello A");
    await rec.close();

    // initialize populated capabilities; calls captured.
    expect(cassette.capabilities?.tools).toBeTruthy();
    expect(cassette.recordedFrom?.name).toBe("mock");
    expect(cassette.interactions.some((i) => i.method === "tools/call")).toBe(true);

    // ── replay (no mock involved) ──
    const connectsBefore = mock.connectCount;
    const rp = await connect(replayTransport(cassette));
    expect((await rp.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(text(await rp.callTool({ name: "echo", arguments: { msg: "hi" } }))).toBe("hi");
    expect(resText(await rp.readResource({ uri: "file:///a" }))).toBe("hello A");
    await rp.close();
    expect(mock.connectCount).toBe(connectsBefore); // replay never touched the upstream
  });

  it("replays repeated identical calls as ordered episodes (stateful)", async () => {
    let n = 0;
    const mock = new MockMCPServer({ tools: [{ name: "next", handler: () => ({ content: [{ type: "text", text: String(++n) }] }) }] });
    const cassette = createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rec.connect(recordTransport(mock.transport(), cassette));
    await rec.callTool({ name: "next", arguments: {} }); // -> 1
    await rec.callTool({ name: "next", arguments: {} }); // -> 2
    await rec.close();

    const rp = await connect(replayTransport(cassette));
    expect(text(await rp.callTool({ name: "next", arguments: {} }))).toBe("1");
    expect(text(await rp.callTool({ name: "next", arguments: {} }))).toBe("2");
    expect(text(await rp.callTool({ name: "next", arguments: {} }))).toBe("2"); // last episode sticks
    await rp.close();
  });

  it("a replay server only advertises recorded capabilities", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "x", handler: () => ({ content: [] }) }] });
    const cassette = createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rec.connect(recordTransport(mock.transport(), cassette));
    await rec.listTools();
    await rec.close();

    const server = replayServer(cassette);
    // tools recorded, prompts/resources never advertised by the mock
    expect(cassette.capabilities?.tools).toBeTruthy();
    expect(cassette.capabilities?.prompts).toBeFalsy();
    expect(server).toBeTruthy();
  });
});
