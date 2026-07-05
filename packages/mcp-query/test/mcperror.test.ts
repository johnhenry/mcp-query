// MCPError is a real Error subclass (was a plain object): String(e) is readable,
// instanceof works, stacks exist — and aborted calls classify as kind "cancelled".

import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MCPError } from "../src/core/types.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("MCPError semantics", () => {
  it("rejections are Error instances with readable String() and preserved fields", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "boom",
          handler: () => {
            throw new Error("kaput");
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const err = await client.callTool("boom", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MCPError);
    expect(String(err)).toContain("kaput"); // was "[object Object]"
    expect((err as MCPError).kind).toBe("protocol");
    expect((err as MCPError).server).toBe("s");
    expect((err as MCPError).stack).toBeTruthy();

    await client.close();
  });

  it("aborted calls classify as kind 'cancelled'", async () => {
    const server = new MockMCPServer({
      tools: [
        {
          name: "slow",
          handler: async () => {
            await tick(200);
            return { content: [] };
          },
        },
      ],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const ac = new AbortController();
    const pending = client.callTool("slow", {}, { signal: ac.signal });
    await tick(10);
    ac.abort();
    const err = (await pending.catch((e: unknown) => e)) as MCPError;
    expect(err).toBeInstanceOf(MCPError);
    expect(err.kind).toBe("cancelled");

    await client.close();
  });
});
