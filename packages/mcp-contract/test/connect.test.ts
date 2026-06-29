import { describe, it, expect } from "vitest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildTransport, connectFromFlags } from "../src/connect.js";

describe("connect helpers", () => {
  it("connectFromFlags parses repeated --header values and --bearer into headers", () => {
    const o = connectFromFlags({ url: "https://host/mcp", bearer: "abc" }, ["X-Tenant: t1", "X-Trace: 9"]);
    expect(o.url).toBe("https://host/mcp");
    expect(o.headers).toEqual({ "X-Tenant": "t1", "X-Trace": "9", Authorization: "Bearer abc" });
  });

  it("buildTransport chooses Streamable HTTP for --url, stdio for --command, and errors on neither", () => {
    expect(buildTransport({ url: "https://host/mcp" })).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(buildTransport({ command: "echo" })).toBeInstanceOf(StdioClientTransport);
    expect(() => buildTransport({})).toThrow(/--url|--command/);
  });
});
