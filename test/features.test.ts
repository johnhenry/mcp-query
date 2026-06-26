import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { DevtoolsHub } from "../src/devtools/protocol.js";
import { argsHash } from "../src/core/keys.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("queryTool (read-only tool as a cached query)", () => {
  it("calls the tool and caches the result under a toolResult key", async () => {
    const mock = new MockMCPServer({
      tools: [
        {
          name: "search",
          annotations: { readOnlyHint: true },
          handler: (a) => ({ content: [{ type: "text", text: `hits:${(a as { q: string }).q}` }] }),
        },
      ],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();

    const res = (await client.queryTool("srv.search", { q: "x" })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("hits:x");

    const key = { kind: "toolResult", server: "srv", tool: "search", argsHash: argsHash({ q: "x" }) } as const;
    expect(client.cache.getSnapshot(key)?.status).toBe("success");
    expect(client.cache.isStale(key)).toBe(false);
    await client.close();
  });
});

describe("resource templates", () => {
  it("loads and caches templates on connect", async () => {
    const mock = new MockMCPServer({
      templates: [{ uriTemplate: "db://{table}", name: "table" }],
    });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    await client.connect();
    expect(client.listResourceTemplates("srv").map((t) => t.uriTemplate)).toEqual(["db://{table}"]);
    expect(client.cache.getSnapshot({ kind: "templateList", server: "srv" })?.status).toBe("success");
    await client.close();
  });
});

describe("server state reactivity", () => {
  it("bumps the server-state version on lifecycle transitions", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "t" }] });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } } });
    const before = client.serverStateVersion();
    await client.connect();
    expect(client.serverState("srv")).toBe("ready");
    expect(client.serverStateVersion()).toBeGreaterThan(before);
    await client.close();
  });
});

describe("server logging capture", () => {
  it("forwards notifications/message into the devtools hub", async () => {
    const hub = new DevtoolsHub();
    const mock = new MockMCPServer({ tools: [{ name: "t" }], logging: true });
    const client = new MCPClient({ servers: { srv: { transport: mock.transport } }, devtools: hub });
    await client.connect();

    await mock.notifyLog("warning", { msg: "disk low" }, "fs");
    await tick();

    const log = hub.events().find((e) => e.type === "log");
    expect(log).toMatchObject({ type: "log", server: "srv", level: "warning" });
    await client.close();
  });
});
