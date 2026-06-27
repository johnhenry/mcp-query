import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { dispatch } from "../src/cli/inspect.js";
import type { MockSpec } from "../src/testing/mockServer.js";

async function connected(spec: MockSpec) {
  const mock = new MockMCPServer(spec);
  const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
  await client.connect();
  return client;
}

describe("inspect CLI dispatch", () => {
  it("tools/list returns the tool catalog", async () => {
    const c = await connected({ tools: [{ name: "a" }, { name: "b" }] });
    expect((await dispatch(c, { method: "tools/list" }, {})) as unknown[]).toHaveLength(2);
    await c.close();
  });

  it("tools/call coerces --arg values (JSON, else string)", async () => {
    const c = await connected({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: JSON.stringify(a) }] }) }] });
    const r = (await dispatch(c, { method: "tools/call", tool: "echo" }, { n: "3", s: "hi" })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain('"n":3');
    expect(r.content[0]!.text).toContain('"s":"hi"');
    await c.close();
  });

  it("resources/read, prompts/list, ping", async () => {
    const c = await connected({ resources: [{ uri: "mem://x", read: () => ({ text: "X" }) }], prompts: [{ name: "p" }], tools: [{ name: "t" }] });
    expect(((await dispatch(c, { method: "resources/read", uri: "mem://x" }, {})) as { contents: { text: string }[] }).contents[0]!.text).toBe("X");
    expect((await dispatch(c, { method: "prompts/list" }, {})) as unknown[]).toHaveLength(1);
    await expect(dispatch(c, { method: "ping" }, {})).resolves.toBeDefined();
    await c.close();
  });

  it("throws on an unknown method", async () => {
    const c = await connected({ tools: [{ name: "t" }] });
    await expect(dispatch(c, { method: "bogus/method" }, {})).rejects.toThrow(/unknown/);
    await c.close();
  });
});
