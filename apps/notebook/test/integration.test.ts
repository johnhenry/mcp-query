// Integration test for the notebook's killer feature: a live resource subscription.
//
// We stand up a *subscribe-capable* MCP server with MockMCPServer (over an in-memory
// transport pair), drive it through a real MCPClient, and prove the full live-update path:
//
//   useResource(uri, { subscribe:true })  -> resources/subscribe
//   write_file tool mutates the file       -> tag invalidation (optimistic confirm)
//   server emits resources/updated         -> cache invalidation -> background re-read
//
// This is exactly what makes "edit a note on disk -> the open viewer updates live" work in
// the app; the real filesystem server lacks resources/subscribe, so the app polls instead,
// but the mechanism the library provides is verified here end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { MCPClient } from "mcp-query";
import { MockMCPServer } from "mcp-query/testing";

function makeNoteServer() {
  const files: Record<string, string> = { "file:///notes/welcome.md": "# Welcome\n\noriginal" };
  const mock = new MockMCPServer({
    resources: [
      { uri: "file:///notes/welcome.md", name: "welcome.md", mimeType: "text/markdown", read: () => ({ text: files["file:///notes/welcome.md"]! }) },
    ],
    tools: [
      {
        name: "write_file",
        description: "Write a note",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        handler: (args) => {
          const uri = `file://${args.path as string}`;
          files[uri] = args.content as string;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    ],
  });
  return { mock, files };
}

function makeClient(mock: MockMCPServer) {
  return new MCPClient({ servers: { fs: { transport: mock.transport } } });
}

function readText(result: unknown): string {
  const contents = (result as { contents?: Array<{ text?: string }> }).contents;
  return contents?.[0]?.text ?? "";
}

describe("live notebook integration", () => {
  let mock: MockMCPServer;
  let client: MCPClient;
  let files: Record<string, string>;
  const uri = "file:///notes/welcome.md";

  beforeEach(async () => {
    ({ mock, files } = makeNoteServer());
    client = makeClient(mock);
    await client.connect();
  });

  it("reads a resource and registers a subscription", async () => {
    const res = await client.readResource(uri, { server: "fs", subscribe: true });
    expect(readText(res)).toBe("# Welcome\n\noriginal");
    expect(mock.subscribed.has(uri)).toBe(true);
  });

  it("write tool mutates the file and a re-read reflects it (optimistic-confirm path)", async () => {
    await client.readResource(uri, { server: "fs", subscribe: true });
    await client.callTool("write_file", { path: "/notes/welcome.md", content: "# Welcome\n\nedited" });
    expect(mock.callLog.at(-1)).toEqual({
      name: "write_file",
      args: { path: "/notes/welcome.md", content: "# Welcome\n\nedited" },
    });
    const after = await client.readResource(uri, { server: "fs", subscribe: true });
    expect(readText(after)).toBe("# Welcome\n\nedited");
  });

  it("a resources/updated notification invalidates the cache (the live-update trigger)", async () => {
    // Prime + subscribe.
    await client.readResource(uri, { server: "fs", subscribe: true });
    expect(client.cache.isStale({ kind: "resource", server: "fs", uri })).toBe(false);

    // Simulate an out-of-band edit (agent / on-disk write) confirmed by the server.
    files[uri] = "# Welcome\n\nfrom an agent";
    await mock.notifyResourceUpdated(uri);
    // Let the notification round-trip through the in-memory transport.
    await new Promise((r) => setTimeout(r, 20));

    // The library marks the entry stale so any observer re-reads (cache-and-network).
    expect(client.cache.isStale({ kind: "resource", server: "fs", uri })).toBe(true);

    const fresh = await client.readResource(uri, { server: "fs", subscribe: true });
    expect(readText(fresh)).toBe("# Welcome\n\nfrom an agent");
  });
});
