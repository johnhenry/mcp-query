import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectEra, parseEra, versionNegotiationFor, DEFAULT_ERA, ERA_PROBE_TIMEOUT_MS } from "../src/index.js";
import { entryToConnectOptions } from "../src/registry.js";

const FIXTURE = fileURLToPath(new URL("./helpers/legacyStdioServer.mjs", import.meta.url));

/** Poll until `cond()` holds (the machine runs other work at the same time). */
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const dirs: string[] = [];
const servers: Server[] = [];
const savedEnv = process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
  if (savedEnv === undefined) delete process.env.MCPQ_ERA_PROBE_TIMEOUT_MS;
  else process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = savedEnv;
});

function stdioOpts(mode: string): { opts: { command: string; args: string; env: Record<string, string> }; marks: () => Array<{ what: string; pid: number }> } {
  const dir = mkdtempSync(join(tmpdir(), "era-"));
  dirs.push(dir);
  const mark = join(dir, "marks");
  return {
    opts: { command: process.execPath, args: FIXTURE, env: { FIXTURE_MODE: mode, FIXTURE_MARK: mark } },
    marks: () => (existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n").filter(Boolean).map((l) => ({ what: l.split(" ")[0]!, pid: Number(l.split(" ")[1]) })) : []),
  };
}

describe("era helpers", () => {
  it("defaults to auto and validates --era values", () => {
    expect(DEFAULT_ERA).toBe("auto");
    expect(parseEra(undefined)).toBeUndefined();
    expect(parseEra("auto")).toBe("auto");
    expect(parseEra("legacy")).toBe("legacy");
    expect(() => parseEra("modern")).toThrow(/--era must be "legacy".*"auto"/);
    expect(() => parseEra("x", "server entry `era`")).toThrow(/server entry `era` must be/);
  });

  it("legacy adds no negotiation; auto bounds the probe (env override honoured)", () => {
    expect(versionNegotiationFor("legacy")).toEqual({});
    expect(versionNegotiationFor("auto")).toEqual({ versionNegotiation: { mode: "auto", probe: { timeoutMs: ERA_PROBE_TIMEOUT_MS } } });
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "250";
    expect(versionNegotiationFor("auto").versionNegotiation?.probe.timeoutMs).toBe(250);
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "nonsense";
    expect(versionNegotiationFor("auto").versionNegotiation?.probe.timeoutMs).toBe(ERA_PROBE_TIMEOUT_MS);
  });

  it("registry entries carry a pinned era into the connect options, and reject a bad one", () => {
    expect(entryToConnectOptions({ command: "x", era: "legacy" }).era).toBe("legacy");
    expect(entryToConnectOptions({ url: "https://h/mcp", era: "auto" }).era).toBe("auto");
    expect(entryToConnectOptions({ url: "https://h/mcp" }).era).toBeUndefined();
    expect(() => entryToConnectOptions({ url: "https://h/mcp", era: "modern" as never })).toThrow(/server entry `era`/);
  });
});

describe("connectEra over stdio (the probe spawns a sibling process)", () => {
  it("--era legacy spawns the server exactly once, with no probe", async () => {
    const { opts, marks } = stdioOpts("reply");
    const { client, close } = await connectEra(opts, "legacy");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    await close();
    await until(() => marks().some((m) => m.what === "stdin-closed"));
    expect(marks().filter((m) => m.what === "start")).toHaveLength(1);
  });

  it("auto against a legacy server falls back to initialize; the probe sibling is gone and only one server stays running", async () => {
    const { opts, marks } = stdioOpts("reply");
    const { client, close } = await connectEra(opts, "auto");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    const starts = marks().filter((m) => m.what === "start");
    expect(starts).toHaveLength(2); // the cost: one extra spawn per auto connect
    // The probe sibling is short-lived: once the connection is up exactly one process is still running.
    await until(() => starts.filter((s) => alive(s.pid)).length === 1);
    await close();
    await until(() => starts.every((s) => !alive(s.pid)));
  });

  it("a server that never answers the probe is bounded by the probe timeout, then treated as legacy", async () => {
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "400";
    const { opts, marks } = stdioOpts("silent");
    const started = Date.now();
    const { client, close } = await connectEra(opts, "auto");
    const took = Date.now() - started;
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
    expect(took).toBeLessThan(8000); // bounded, far below the SDK's 60 s default request timeout
    const starts = marks().filter((m) => m.what === "start");
    expect(starts).toHaveLength(2);
    await close();
    await until(() => starts.every((s) => !alive(s.pid))); // the timed-out probe process was reaped too
  });

  it("a server that dies on the unrecognised probe is simply legacy", async () => {
    const { opts } = stdioOpts("exit");
    const { client, close } = await connectEra(opts, "auto");
    expect((await client.listTools()).tools).toHaveLength(1);
    await close();
  });

  it("uses the entry's pinned era when none is passed (legacy: one spawn)", async () => {
    const { opts, marks } = stdioOpts("reply");
    const { close } = await connectEra({ ...opts, era: "legacy" });
    await close();
    await until(() => marks().some((m) => m.what === "stdin-closed"));
    expect(marks().filter((m) => m.what === "start")).toHaveLength(1);
  });
});

/** A 2025-era Streamable HTTP server: JSON responses; `hangOnDiscover` never answers `server/discover`. */
function httpServer(hangOnDiscover: boolean): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = body ? (JSON.parse(body) as { id?: number; method: string }) : undefined;
      if (req.method !== "POST" || !m) {
        res.writeHead(405).end();
        return;
      }
      if (m.method === "server/discover" && hangOnDiscover) return; // never respond
      if (m.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        m.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-legacy", version: "1" } }
          : m.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : {};
      const reply = m.method === "server/discover" ? { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } } : { jsonrpc: "2.0", id: m.id, result };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`)));
}

describe("connectEra over HTTP", () => {
  it("auto against a server that rejects server/discover connects as legacy", async () => {
    const url = await httpServer(false);
    const { client, close } = await connectEra({ url }, "auto");
    expect((await client.listTools()).tools).toHaveLength(1);
    await close();
  });

  it("a server that never answers the probe: bounded timeout, then one retry with the legacy handshake", async () => {
    process.env.MCPQ_ERA_PROBE_TIMEOUT_MS = "300";
    const url = await httpServer(true);
    const started = Date.now();
    const { client, close } = await connectEra({ url }, "auto");
    expect(Date.now() - started).toBeLessThan(8000);
    expect((await client.listTools()).tools).toHaveLength(1);
    await close();
  });

  it("an unreachable server fails with its own error (no legacy retry masking an outage)", async () => {
    const url = await httpServer(false);
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    await expect(connectEra({ url }, "auto")).rejects.toThrow();
  });
});
