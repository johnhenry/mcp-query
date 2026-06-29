// Integration: drive a real MCPClient against an in-memory MockMCPServer, then assert the
// Console's render helpers turn discovered capabilities + a tool call into the right DOM.

import { describe, it, expect } from "vitest";
import { MCPClient, isReadOnly, isDestructive } from "mcp-query";
import { MockMCPServer } from "mcp-query/testing";
import { renderToolResult, type ToolResult } from "../src/lib/render.js";

function makeServer() {
  return new MockMCPServer({
    tools: [
      {
        name: "list_users",
        description: "Return the users table",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
        handler: (args) => [
          { id: 1, name: "Ada", role: "admin" },
          { id: 2, name: "Linus", role: "user" },
        ].slice(0, (args.limit as number) ?? 10),
      },
      {
        name: "delete_user",
        description: "Delete a user (danger!)",
        annotations: { destructiveHint: true },
        inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
        handler: () => ({ content: [{ type: "text", text: "deleted" }] }),
      },
    ],
    resources: [{ uri: "mem://readme", name: "readme", mimeType: "text/plain", read: () => ({ text: "hello world" }) }],
    prompts: [
      {
        name: "greet",
        description: "Greeting prompt",
        get: (a) => ({ messages: [{ role: "user", content: { type: "text", text: `Hi ${a.who}` } }] }),
      },
    ],
  });
}

describe("console + MCPClient over in-memory transport", () => {
  it("discovers tools/resources/prompts and surfaces annotations", async () => {
    const mock = makeServer();
    const client = new MCPClient({ servers: { demo: { transport: mock.transport } } });
    await client.connect();

    const tools = client.listTools("demo");
    expect(tools.map((t) => t.name).sort()).toEqual(["delete_user", "list_users"]);
    expect(isReadOnly(tools.find((t) => t.name === "list_users"))).toBe(true);
    expect(isDestructive(tools.find((t) => t.name === "delete_user"))).toBe(true);

    expect(client.listResources("demo").map((r) => r.uri)).toEqual(["mem://readme"]);
    expect(client.listPrompts("demo").map((p) => p.name)).toEqual(["greet"]);

    await client.removeServer("demo");
  });

  it("calls a tool and renders the result as a table", async () => {
    const mock = makeServer();
    const client = new MCPClient({ servers: { demo: { transport: mock.transport } } });
    await client.connect();

    const result = (await client.callTool("demo.list_users", {})) as ToolResult;
    const html = renderToolResult(result);

    expect(html).toContain("<table");
    expect(html).toContain("<th>id</th>");
    expect(html).toContain("<th>name</th>");
    expect(html).toContain("Ada");
    expect(html).toContain("Linus");

    expect(mock.callLog.at(-1)?.name).toBe("list_users");
    await client.removeServer("demo");
  });

  it("reads a resource through the client and renders its contents", async () => {
    const mock = makeServer();
    const client = new MCPClient({ servers: { demo: { transport: mock.transport } } });
    await client.connect();

    const data = await client.readResource("mem://readme", { server: "demo" });
    const { renderResourceContents } = await import("../src/lib/render.js");
    expect(renderResourceContents(data)).toContain("hello world");

    await client.removeServer("demo");
  });

  it("mounts a custom element and renders empty-state when no server is active", async () => {
    await import("../src/components/console-tool.js");
    const el = document.createElement("console-tool");
    document.body.append(el);
    // activeServer signal is "" in the test env → placeholder.
    expect(el.innerHTML).toContain("placeholder");
    el.remove();
  });
});
