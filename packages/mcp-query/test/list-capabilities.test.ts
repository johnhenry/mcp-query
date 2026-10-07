import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

async function make() {
  const a = new MockMCPServer({
    tools: [{ name: "add" }],
    resources: [{ uri: "file:///a", name: "a" }],
    prompts: [{ name: "pa" }],
  });
  const b = new MockMCPServer({ tools: [{ name: "mul" }, { name: "div" }], prompts: [{ name: "pb" }] });
  const client = new MCPClient({ servers: { alpha: { transport: a.transport }, beta: { transport: b.transport } } });
  await client.connect();
  return client;
}

describe("list* with an optional server (#41)", () => {
  it("a named server returns that server's plain entries", async () => {
    const c = await make();
    expect(c.listTools("alpha").map((t) => t.name)).toEqual(["add"]);
    expect(c.listPrompts("beta").map((t) => t.name)).toEqual(["pb"]);
    await c.close();
  });

  it("omitting the server returns the union across servers, each tagged with `server`", async () => {
    const c = await make();
    const tools = c.listTools();
    expect(tools.map((t) => `${t.server}.${t.name}`).sort()).toEqual(["alpha.add", "beta.div", "beta.mul"]);
    expect(c.listPrompts().map((p) => `${p.server}.${p.name}`).sort()).toEqual(["alpha.pa", "beta.pb"]);
    expect(c.listResources().map((r) => `${r.server}:${r.uri}`)).toEqual(["alpha:file:///a"]);
    expect(c.listResourceTemplates()).toEqual([]);
    await c.close();
  });

  it("an unknown server name throws a clear MCPError listing configured servers", async () => {
    const c = await make();
    for (const call of [
      () => c.listTools("alhpa"),
      () => c.listResources("alhpa"),
      () => c.listResourceTemplates("alhpa"),
      () => c.listPrompts("alhpa"),
    ]) {
      expect(call).toThrow(MCPError);
      expect(call).toThrow(/unknown server "alhpa".*alpha, beta/);
    }
    await c.close();
  });

  it("an empty client without a server returns []", async () => {
    const c = new MCPClient({ servers: {} });
    expect(c.listTools()).toEqual([]);
  });
});
