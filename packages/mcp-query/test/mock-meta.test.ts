import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

describe("MockMCPServer _meta passthrough", () => {
  it("advertises _meta on tools/list, resources/list and resources/read contents", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "t", _meta: { ui: { resourceUri: "ui://x" } }, handler: () => ({ content: [] }) }],
      resources: [{ uri: "ui://x", mimeType: "text/html", _meta: { ui: { csp: {} } }, read: () => ({ text: "<p/>" }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    expect((client.listTools("s")[0] as { _meta?: unknown })._meta).toEqual({ ui: { resourceUri: "ui://x" } });
    expect((client.listResources("s")[0] as { _meta?: unknown })._meta).toEqual({ ui: { csp: {} } });
    const read = (await client.readResource("ui://x")) as { contents: Array<{ _meta?: unknown }> };
    expect(read.contents[0]!._meta).toEqual({ ui: { csp: {} } });
    await client.close();
  });
});
