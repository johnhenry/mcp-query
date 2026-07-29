import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MCPClient, resourceTag } from "@johnhenry/mcpq";
import { MockMCPServer } from "@johnhenry/mcpq/testing";
import { mcpqToolMutationOptions } from "../src/mutationOptions.js";

describe("mcpqToolMutationOptions", () => {
  it("mutationFn delegates to client.callTool with the given args", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "write", handler: (a) => ({ content: [{ type: "text", text: `wrote:${a.v}` }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = new QueryClient();

    const opts = mcpqToolMutationOptions(client, qc, "s.write");
    const result = await opts.mutationFn!({ v: "x" }, { client: qc, meta: undefined });
    expect((result as { content: { text: string }[] }).content[0]!.text).toBe("wrote:x");

    await client.close();
  });

  it("onSettled invalidates the exact translated prefix for each declared tag", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "write", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = new QueryClient();
    const invalidated: unknown[] = [];
    qc.invalidateQueries = ((filters: unknown) => {
      invalidated.push(filters);
      return Promise.resolve();
    }) as typeof qc.invalidateQueries;

    const opts = mcpqToolMutationOptions(client, qc, "s.write", { invalidatesTags: [resourceTag("s", "mem://a")] });
    await opts.mutationFn!({}, { client: qc, meta: undefined });
    await (opts.onSettled as (...args: unknown[]) => unknown)?.();

    expect(invalidated).toEqual([{ queryKey: ["mcpq", "s", "resource", "mem://a"] }]);
    await client.close();
  });
});
