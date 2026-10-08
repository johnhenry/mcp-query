import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { clientCapabilities } from "../src/core/handlers.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const UI = "io.modelcontextprotocol/ui";

describe("MCPClientConfig.extensions", () => {
  it("clientCapabilities merges extra extensions next to the built-in tasks extension", () => {
    const caps = clientCapabilities({}, { [UI]: { mimeTypes: ["text/html;profile=mcp-app"] } }) as { extensions: Record<string, unknown> };
    expect(caps.extensions[UI]).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
    expect(Object.keys(caps.extensions)).toHaveLength(2);
  });

  it("an opted-in extension reaches the server on both protocol eras; default advertises nothing extra", async () => {
    for (const era of ["legacy", "modern"] as const) {
      const mock = new MockMCPServer({ tools: [{ name: "t", handler: () => ({ content: [] }) }] }, { era });
      const client = new MCPClient({
        servers: { s: { transport: mock.transport } },
        versions: era === "modern" ? ["2026-07-28"] : undefined,
        extensions: { [UI]: { mimeTypes: ["text/html;profile=mcp-app"] } },
      });
      await client.connect();
      await client.callTool("t", {});
      expect(mock.clientCapabilities()?.extensions?.[UI], era).toEqual({ mimeTypes: ["text/html;profile=mcp-app"] });
      await client.close();

      const plain = new MockMCPServer({ tools: [{ name: "t", handler: () => ({ content: [] }) }] }, { era });
      const c2 = new MCPClient({ servers: { s: { transport: plain.transport } }, versions: era === "modern" ? ["2026-07-28"] : undefined });
      await c2.connect();
      await c2.callTool("t", {});
      expect(plain.clientCapabilities()?.extensions?.[UI], era).toBeUndefined();
      await c2.close();
    }
  });
});
