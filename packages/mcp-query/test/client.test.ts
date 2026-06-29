import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { resourceTag } from "../src/core/tags.js";
import type { CacheKey } from "../src/core/keys.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function twoServerClient() {
  const fs = new MockMCPServer({
    resources: [{ uri: "file:///a", read: () => ({ text: "AAA" }) }],
    tools: [{ name: "read_file", annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
  });
  const github = new MockMCPServer({
    tools: [
      { name: "create_issue", annotations: { destructiveHint: false }, handler: (a) => ({ content: [{ type: "text", text: `#${(a as any).title}` }] }) },
      { name: "boom", handler: () => ({ content: [{ type: "text", text: "nope" }], isError: true }) },
    ],
    resources: [{ uri: "github://issues", read: () => ({ text: "[]" }) }],
  });
  const client = new MCPClient({
    servers: {
      fs: { transport: fs.transport },
      github: { transport: github.transport },
    },
    schemeMap: { file: "fs", github: "github" },
  });
  return { client, fs, github };
}

describe("multiplexing", () => {
  it("connects multiple servers and routes tool calls by namespace and unique name", async () => {
    const { client, github } = twoServerClient();
    await client.connect();

    const r1 = (await client.callTool("github.create_issue", { title: "X" })) as any;
    expect(r1.content[0].text).toBe("#X");

    const r2 = (await client.callTool("read_file", {})) as any; // unique name, routed to fs
    expect(r2.content[0].text).toBe("ok");

    expect(github.callLog.map((c) => c.name)).toContain("create_issue");
    await client.close();
  });
});

describe("reads & caching", () => {
  it("readResource writes a fresh, URI-tagged cache entry", async () => {
    const { client } = twoServerClient();
    await client.connect();
    await client.readResource("file:///a");
    const key: CacheKey = { kind: "resource", server: "fs", uri: "file:///a" };
    const e = client.cache.getSnapshot(key);
    expect(e?.status).toBe("success");
    expect(e?.tags.has(resourceTag("fs", "file:///a"))).toBe(true);
    expect(client.cache.isStale(key)).toBe(false);
    await client.close();
  });

  it("ref-counts a protocol subscription when subscribe:true", async () => {
    const { client, fs } = twoServerClient();
    await client.connect();
    await client.readResource("file:///a", { subscribe: true });
    expect(fs.subscribed.has("file:///a")).toBe(true);
    await client.close();
  });
});

describe("mutations & invalidation", () => {
  it("invalidates declared tags after a successful tool call", async () => {
    const { client } = twoServerClient();
    await client.connect();
    const key: CacheKey = { kind: "resource", server: "github", uri: "github://issues" };
    await client.readResource("github://issues");
    expect(client.cache.isStale(key)).toBe(false);

    await client.callTool("github.create_issue", { title: "Y" }, {
      invalidates: [resourceTag("github", "github://issues")],
    });
    expect(client.cache.isStale(key)).toBe(true);
    await client.close();
  });

  it("rolls back an optimistic patch when the tool returns isError", async () => {
    const { client } = twoServerClient();
    await client.connect();
    const key: CacheKey = { kind: "resource", server: "github", uri: "github://issues" };
    client.cache.write(key, { items: ["existing"] });

    await client.callTool("github.boom", {}, {
      optimistic: () => [{ key, recipe: (p: any) => ({ items: [...p.items, "optimistic"] }) }],
    });

    // boom returns isError -> the optimistic patch must be rolled back.
    expect(client.cache.getSnapshot(key)?.data).toEqual({ items: ["existing"] });
    await client.close();
  });
});
