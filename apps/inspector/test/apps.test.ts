import { describe, expect, it } from "vitest";
import { MCPClient } from "@johnhenry/mcp-query";
import { MockMCPServer } from "@johnhenry/mcp-query/testing";
import { mcpAppsExtensions } from "@johnhenry/mcp-query-ui";
import { hostFor, listAppTools, sandboxProxyUrl } from "../src/lib/apps.js";

const URI = "ui://demo/app";

async function connected() {
  const mock = new MockMCPServer({
    tools: [
      { name: "plain", handler: () => ({ content: [{ type: "text", text: "x" }] }) },
      { name: "show", _meta: { ui: { resourceUri: URI } }, handler: () => ({ content: [{ type: "text", text: "x" }] }) },
      { name: "helper", _meta: { ui: { resourceUri: URI, visibility: ["app"] } }, handler: () => ({ content: [{ type: "text", text: "x" }] }) },
    ],
    resources: [{ uri: URI, name: "app", mimeType: "text/html;profile=mcp-app", read: () => ({ text: "<p>app</p>" }) }],
  });
  const client = new MCPClient({ servers: { demo: { transport: mock.transport } }, extensions: mcpAppsExtensions() });
  await client.connect();
  return client;
}

describe("inspector MCP Apps wiring", () => {
  it("lists only tools carrying _meta.ui.resourceUri, flagging app-only ones", async () => {
    const client = await connected();
    expect(listAppTools(client, "demo").map((t) => [t.name, t.uri, t.appOnly])).toEqual([
      ["show", URI, false],
      ["helper", URI, true],
    ]);
    await client.close();
  });

  it("opens a session through the host (resource read goes via the client) without a sandbox", async () => {
    const client = await connected();
    const session = await hostFor(client, "demo").open({ tool: "show" });
    expect(session.getState().status).toBe("loaded");
    expect(session.resource.html).toContain("app");
    expect(session.resource.cspHeader).toContain("default-src 'none'");
    await session.close();
    await client.close();
  });

  it("puts the sandbox proxy on a different origin than the inspector", () => {
    const loc = { hostname: "localhost", origin: "http://localhost:5173", search: "?proxyToken=t" };
    const url = new URL(sandboxProxyUrl(loc));
    expect(url.origin).not.toBe(loc.origin);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.searchParams.get("host")).toBe(loc.origin);
    expect(new URL(sandboxProxyUrl({ ...loc, hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" })).hostname).toBe("localhost");
    expect(sandboxProxyUrl({ ...loc, search: "?sandboxPort=6000" })).toContain(":6000/");
  });
});
