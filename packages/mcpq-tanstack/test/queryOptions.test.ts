import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MCPClient, argsHash } from "@johnhenry/mcpq";
import { MockMCPServer } from "@johnhenry/mcpq/testing";
import { mcpqResourceQueryOptions, mcpqToolListQueryOptions, mcpqToolQueryOptions } from "../src/queryOptions.js";

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("mcpqToolQueryOptions", () => {
  it("queryFn delegates to client.queryTool and the queryKey matches the tool/args", async () => {
    const mock = new MockMCPServer({
      tools: [{ name: "search", annotations: { readOnlyHint: true }, handler: (a) => ({ content: [{ type: "text", text: `found:${a.q}` }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = newQueryClient();

    const opts = mcpqToolQueryOptions(client, "s.search", { q: "cats" });
    expect(opts.queryKey).toEqual(["mcpq", "s", "toolResult", "search", argsHash({ q: "cats" })]);
    const result = await qc.fetchQuery(opts);
    expect((result as { content: { text: string }[] }).content[0]!.text).toBe("found:cats");

    await client.close();
  });
});

describe("mcpqResourceQueryOptions", () => {
  it("queryFn delegates to client.readResource and the queryKey matches the uri", async () => {
    const mock = new MockMCPServer({ resources: [{ uri: "mem://a", read: () => ({ text: "A" }) }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = newQueryClient();

    const opts = mcpqResourceQueryOptions(client, "mem://a", { server: "s" });
    expect(opts.queryKey).toEqual(["mcpq", "s", "resource", "mem://a"]);
    const result = await qc.fetchQuery(opts);
    expect(result).toBeTruthy();

    await client.close();
  });
});

describe("mcpqToolListQueryOptions", () => {
  it("queryFn delegates to client.listTools and the queryKey matches the server", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "a" }, { name: "b" }] });
    const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
    await client.connect();
    const qc = newQueryClient();

    const opts = mcpqToolListQueryOptions(client, "s");
    expect(opts.queryKey).toEqual(["mcpq", "s", "toolList"]);
    const tools = await qc.fetchQuery(opts);
    expect(tools.map((t) => t.name).sort()).toEqual(["a", "b"]);

    await client.close();
  });
});
