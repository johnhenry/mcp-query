// Recording over Streamable HTTP: spin up a real SDK server behind node:http,
// record a session against its URL (capability surface + --call specs in BOTH
// syntaxes), then replay the cassette fully offline.

import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { run, recordSession } from "../src/cli.js";
import { replayTransport } from "../src/replay.js";
import type { Cassette } from "../src/cassette.js";

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

/** A stateless Streamable HTTP MCP server (fresh Server+transport per request). */
function startHttpFixture(): Promise<{ url: string; httpServer: HttpServer; upstreamCalls: string[] }> {
  const upstreamCalls: string[] = [];
  const httpServer = createServer((req, res) => {
    void (async () => {
      const server = new Server({ name: "http-fixture", version: "1.2.3" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({
          tools: [{ name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { message: { type: "string" } } } }],
        }),
      );
      server.setRequestHandler(CallToolRequestSchema, (r) => {
        const message = String((r.params.arguments as { message?: unknown } | undefined)?.message);
        upstreamCalls.push(message);
        return Promise.resolve({ content: [{ type: "text", text: message }] });
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close());
      await server.connect(transport);
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? (JSON.parse(body) as unknown) : undefined);
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, httpServer, upstreamCalls });
    });
  });
}

describe("record over Streamable HTTP", () => {
  let url: string;
  let httpServer: HttpServer;
  let upstreamCalls: string[];

  beforeAll(async () => {
    ({ url, httpServer, upstreamCalls } = await startHttpFixture());
  });
  afterAll(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
  afterEach(() => vi.restoreAllMocks());

  it("records a hosted server via --url and replays it offline (both --call syntaxes)", async () => {
    const cassette = await recordSession({ url }, ['echo(message: "fn-form")', 'echo:{"message":"json-form"}']);

    expect(cassette.recordedFrom?.name).toBe("http-fixture");
    expect(cassette.capabilities?.tools).toBeTruthy();
    expect(cassette.interactions.some((i) => i.method === "tools/list")).toBe(true);
    expect(cassette.interactions.filter((i) => i.method === "tools/call")).toHaveLength(2);
    expect(upstreamCalls).toEqual(["fn-form", "json-form"]);

    // ── replay: fully offline, never touches the HTTP server again ──
    const before = upstreamCalls.length;
    const rp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rp.connect(replayTransport(cassette)());
    expect((await rp.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(text(await rp.callTool({ name: "echo", arguments: { message: "fn-form" } }))).toBe("fn-form");
    expect(text(await rp.callTool({ name: "echo", arguments: { message: "json-form" } }))).toBe("json-form");
    await rp.close();
    expect(upstreamCalls.length).toBe(before);
  });

  it("the record subcommand accepts --url and prints the hosted-traffic warning", async () => {
    const out = join(tmpdir(), `mcp-record-http-${Date.now()}.json`);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run(["record", "--url", url, "--out", out]);
      expect(errSpy.mock.calls.flat().join("\n")).toMatch(/recording a hosted server sends real traffic/);
      const cassette = JSON.parse(await readFile(out, "utf8")) as Cassette;
      expect(cassette.recordedFrom?.name).toBe("http-fixture");
      expect(cassette.interactions.some((i) => i.method === "tools/list")).toBe(true);
    } finally {
      await rm(out, { force: true });
    }
  });
});

describe("record CLI arg validation", () => {
  it("rejects unknown flags with the known list", async () => {
    await expect(run(["record", "--nope", "x"])).rejects.toThrow(/unknown flag --nope for mcp-record \(known: .*--url/);
  });

  it("requires a connection (url, command, or registered server)", async () => {
    await expect(run(["record"])).rejects.toThrow(/--url|--command/);
  });

  it("rejects a malformed --call spec naming both accepted forms", async () => {
    await expect(run(["record", "--command", "true", "--call", "echo(message"])).rejects.toThrow(/tool:\{"arg":"value"\}.*tool\(arg: "value"/s);
  });
});
