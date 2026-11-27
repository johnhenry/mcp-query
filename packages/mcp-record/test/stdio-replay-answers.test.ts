// `mcp-record replay` over stdio for both eras, `record --call --answer`, and the `--era auto` default's fallbacks.
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Client, type Transport } from "@modelcontextprotocol/client";
import { ReadBuffer, serializeMessage, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { InputRequiredError } from "@johnhenry/mcp-contract";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { createCassette, sealCassette, type Cassette } from "../src/cassette.js";
import { recordTransport } from "../src/record.js";
import { replayOverStdio } from "../src/replayStdio.js";
import { recordSession, run } from "../src/cli.js";
import { replayTransport } from "../src/replay.js";

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
const FIXTURE = fileURLToPath(new URL("../../mcp-contract/test/helpers/legacyStdioServer.mjs", import.meta.url));

/** A client transport over a pair of byte streams (what a stdio client does with a child's pipes). */
function streamClient(read: PassThrough, write: PassThrough, sent: JSONRPCMessage[]): Transport {
  const buffer = new ReadBuffer();
  const t: Transport = {
    async start() {
      read.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (let m = buffer.readMessage(); m; m = buffer.readMessage()) t.onmessage?.(m);
      });
    },
    async send(message) {
      sent.push(message);
      write.write(serializeMessage(message));
    },
    async close() {
      write.end();
      t.onclose?.();
    },
  };
  return t;
}

function stdioPair() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  return { toServer, fromServer, serverTransport: () => new StdioServerTransport(toServer, fromServer) };
}

async function modernCassette(): Promise<Cassette> {
  const mock = new MockMCPServer({ tools: [{ name: "echo", description: "e", inputSchema: { type: "object", properties: { message: { type: "string" } } }, handler: (a) => ({ content: [{ type: "text", text: String(a.message) }] }) }] }, { era: "modern" });
  const cassette = createCassette();
  const rec = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  await rec.connect(recordTransport(mock.transport(), cassette));
  expect(rec.getProtocolEra()).toBe("modern");
  await rec.listTools();
  await rec.callTool({ name: "echo", arguments: { message: "hi" } });
  await rec.close();
  await mock.close();
  return sealCassette(cassette);
}

async function legacyCassette(): Promise<Cassette> {
  const mock = new MockMCPServer({ tools: [{ name: "echo", description: "e", inputSchema: { type: "object", properties: { message: { type: "string" } } }, handler: (a) => ({ content: [{ type: "text", text: String(a.message) }] }) }] }, { era: "legacy" });
  const cassette = createCassette();
  const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await rec.connect(recordTransport(mock.transport(), cassette));
  await rec.listTools();
  await rec.callTool({ name: "echo", arguments: { message: "hi" } });
  await rec.close();
  await mock.close();
  return sealCassette(cassette);
}

describe("mcp-record replay over stdio", () => {
  it("serves a modern-era cassette to a modern client: server/discover, no initialize", async () => {
    const cassette = await modernCassette();
    expect(cassette.protocol?.era).toBe("modern");
    const { toServer, fromServer, serverTransport } = stdioPair();
    const handle = await replayOverStdio(JSON.parse(JSON.stringify(cassette)), {}, serverTransport());
    expect(handle.era).toBe("modern");
    const sent: JSONRPCMessage[] = [];
    const client = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
    await client.connect(streamClient(fromServer, toServer, sent));
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      expect(text(await client.callTool({ name: "echo", arguments: { message: "hi" } }))).toBe("hi");
      const methods = sent.map((m) => (m as { method?: string }).method);
      expect(methods).toContain("server/discover");
      expect(methods).not.toContain("initialize");
    } finally {
      await client.close();
      await handle.close().catch(() => {});
    }
  });

  it("a legacy client is refused by a modern cassette (it is a 2026-07-28 server)", async () => {
    const cassette = await modernCassette();
    const { toServer, fromServer, serverTransport } = stdioPair();
    const handle = await replayOverStdio(cassette, {}, serverTransport());
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await expect(client.connect(streamClient(fromServer, toServer, []))).rejects.toThrow();
    await client.close().catch(() => {});
    await handle.close().catch(() => {});
  });

  it("still serves a classic cassette with the initialize handshake", async () => {
    const cassette = await legacyCassette();
    expect(cassette.protocol?.era).not.toBe("modern");
    const { toServer, fromServer, serverTransport } = stdioPair();
    const handle = await replayOverStdio(cassette, {}, serverTransport());
    expect(handle.era).toBe("legacy");
    const sent: JSONRPCMessage[] = [];
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(streamClient(fromServer, toServer, sent));
    try {
      expect(text(await client.callTool({ name: "echo", arguments: { message: "hi" } }))).toBe("hi");
      expect(sent.map((m) => (m as { method?: string }).method)).toContain("initialize");
    } finally {
      await client.close();
      await handle.close().catch(() => {});
    }
  });
});

// ── record --call --answer ────────────────────────────────────────────────────

let httpServer: HttpServer | undefined;
let mock: MockMCPServer | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()));
  await mock?.close();
  httpServer = undefined;
  mock = undefined;
});

/** Serve a modern-era mock with an elicitation-asking tool over real HTTP. */
async function askServer(): Promise<string> {
  mock = new MockMCPServer(
    {
      tools: [
        {
          name: "ask",
          description: "asks for a name",
          handler: async (_a, ctx) => {
            const r = await ctx.elicit({ message: "name?", requestedSchema: { type: "object", properties: { n: { type: "string" } }, required: ["n"] } });
            return { content: [{ type: "text", text: r.action === "accept" ? `hello ${String((r.content as { n?: unknown } | undefined)?.n)}` : r.action }] };
          },
        },
      ],
    },
    { era: "modern" },
  );
  const dispatch = (mock as unknown as { dispatch(r: Request): Promise<Response> }).dispatch;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
      const response = await dispatch.call(mock, new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  httpServer = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe("mcp-record record --call … --answer", () => {
  it("answers an input_required round and records both rounds, which replay offline", async () => {
    const url = await askServer();
    const cassette = await recordSession({ url }, ["ask"], [], "auto", ["n=Ada"]);
    const calls = cassette.interactions.filter((i) => i.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.kind)).toEqual(["mrtr", "mrtr"]);
    expect((calls[0]!.result as { resultType?: string }).resultType).toBe("input_required");
    expect(text(calls[1]!.result)).toBe("hello Ada");

    const rp = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: "auto" } });
    rp.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { n: "Ada" } }) as never);
    await rp.connect(replayTransport(JSON.parse(JSON.stringify(cassette)))());
    expect(text(await rp.callTool({ name: "ask", arguments: {} }))).toBe("hello Ada");
    await rp.close();
  });

  it("fails clearly without --answer: no half-recorded cassette, and the message names --answer", async () => {
    const url = await askServer();
    const err = await recordSession({ url }, ["ask"], [], "auto", []).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/needs a capability.*--answer key=value/s);
  });

  it("an answer that does not cover the question aborts with the pending question listed", async () => {
    const url = await askServer();
    const err = await recordSession({ url }, ["ask"], [], "auto", ["other=1"]).catch((e) => e);
    expect(err).toBeInstanceOf(InputRequiredError);
    expect(String(err.message)).toContain("name?");
    expect(String(err.message)).toMatch(/--answer <key>=<value>/);
  });

  it("the CLI takes repeatable --answer, writes the cassette, and refuses --answer with --era legacy", async () => {
    const url = await askServer();
    const dir = await mkdtemp(join(tmpdir(), "rec-answer-"));
    const out = join(dir, "tape.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run(["record", "--url", url, "--call", "ask", "--answer", "n=Grace", "--out", out]);
      const cassette = JSON.parse(await readFile(out, "utf8")) as Cassette;
      expect(text(cassette.interactions.filter((i) => i.method === "tools/call")[1]!.result)).toBe("hello Grace");
      await expect(run(["record", "--url", url, "--call", "ask", "--answer", "n=x", "--era", "legacy"])).rejects.toThrow(/drop --era legacy/);
      await expect(run(["record", "--url", url, "--call", "ask", "--answer", "oops"])).rejects.toThrow(/key=value/);
      await expect(run(["record", "--url", url, "--call", "ask"])).rejects.toThrow(/--answer key=value/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mcp-record record --era auto (the default)", () => {
  it("records a 2025-era stdio server as legacy when the probe is answered with an error", async () => {
    const cassette = await recordSession({ command: process.execPath, args: FIXTURE, env: { FIXTURE_MODE: "reply" } }, []);
    expect(cassette.recordedFrom?.name).toBe("legacy-fixture");
    expect(cassette.protocol?.era).not.toBe("modern");
  });

  it("a server that exits on the unrecognised probe is still recorded (as legacy)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cassette = await recordSession({ command: process.execPath, args: FIXTURE, env: { FIXTURE_MODE: "exit" } }, []);
    expect(cassette.recordedFrom?.name).toBe("legacy-fixture");
  });

  it("an auto connect that fails is retried once, from scratch, as legacy", async () => {
    // A 2025-era HTTP server that answers the server/discover probe with a hard 500 (not a clean legacy signal).
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = body ? (JSON.parse(body) as { id?: number; method: string }) : undefined;
        if (!m) return void res.writeHead(405).end();
        seen.push(m.method);
        if (m.method === "server/discover") return void res.writeHead(500).end("boom");
        if (m.id === undefined) return void res.writeHead(202).end();
        const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "flaky-legacy", version: "1" } } : m.method === "tools/list" ? { tools: [] } : {};
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    httpServer = server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const cassette = await recordSession({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` }, []);
    expect(cassette.recordedFrom?.name).toBe("flaky-legacy");
    expect(seen).toContain("initialize");
    expect(err.mock.calls.flat().join("\n")).toMatch(/recording again as legacy/);
  });

  it("a server that never answers the probe is bounded by the probe timeout, then recorded as legacy", async () => {
    const saved = process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "300";
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const cassette = await recordSession({ command: process.execPath, args: FIXTURE, env: { FIXTURE_MODE: "silent" } }, []);
      expect(cassette.recordedFrom?.name).toBe("legacy-fixture");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      if (saved === undefined) delete process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
      else process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = saved;
    }
  });

  it("--era legacy skips the probe entirely", async () => {
    const cassette = await recordSession({ command: process.execPath, args: FIXTURE, env: { FIXTURE_MODE: "silent" } }, [], [], "legacy");
    expect(cassette.recordedFrom?.name).toBe("legacy-fixture");
  });
});
