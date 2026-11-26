// Pins the WebSocket<->MCP bridge protocol documented in docs/ws-stdio-bridge.md against the
// real proxy (src/proxy.ts), using real `ws` clients and a real stdio child process.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startProxy, type ProxyHandle, type StartProxyOptions } from "../src/proxy.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/stdio-echo.mjs", import.meta.url));
const stdioTarget = (extra: Record<string, unknown> = {}) => ({ transport: "stdio", command: process.execPath, args: [FIXTURE], ...extra });

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const TOKEN = "test-token";
let proxy: ProxyHandle | undefined;
let port = 0;
async function up(opts: StartProxyOptions = {}) {
  port = await freePort();
  proxy = await startProxy({ port, token: TOKEN, ...opts });
}
afterEach(async () => { await proxy?.close(); proxy = undefined; });

interface Client { ws: WebSocket; frames: any[]; closed: Promise<{ code: number; reason: string }>; next(pred?: (f: any) => boolean): Promise<any>; send(f: unknown): void }
function connect(query = `?token=${TOKEN}`, headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { headers });
  const frames: any[] = [];
  const waiters: Array<{ pred: (f: any) => boolean; res: (f: any) => void }> = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(f));
    if (i >= 0) waiters.splice(i, 1)[0]!.res(f); else frames.push(f);
  });
  const closed = new Promise<{ code: number; reason: string }>((res) => ws.on("close", (code, reason) => res({ code, reason: reason.toString() })));
  const client: Client = {
    ws, frames, closed,
    send: (f) => ws.send(JSON.stringify(f)),
    next: (pred = () => true) => {
      const i = frames.findIndex(pred);
      if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        waiters.push({ pred, res });
        setTimeout(() => rej(new Error("timed out waiting for a frame")), 10_000);
      });
    },
  };
  return new Promise((res, rej) => { ws.once("open", () => res(client)); ws.once("error", rej); });
}
const rpc = (id: number, method: string, params?: unknown) => ({ msg: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } });

describe("bridge: admission (token, Origin, bind)", () => {
  it("closes 1008 'bad token' when the token is wrong or missing", async () => {
    await up();
    for (const q of ["?token=nope", ""]) {
      const c = await connect(q);
      expect(await c.closed).toEqual({ code: 1008, reason: "bad token" });
    }
  });

  it("accepts the token with no Origin header (non-browser client) by default", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: stdioTarget() } });
    expect(await c.next()).toEqual({ control: { connected: true } });
    c.ws.close();
  });

  it("default Origin policy: only http://localhost and http://127.0.0.1 (any port)", async () => {
    await up();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1", "http://localhost"]) {
      const c = await connect(undefined, { Origin: origin });
      c.send({ control: { connect: stdioTarget() } });
      expect(await c.next(), origin).toEqual({ control: { connected: true } });
      c.ws.close();
    }
    for (const origin of ["https://evil.example", "http://localhost.evil.example", "https://localhost:5173", "null"]) {
      const c = await connect(undefined, { Origin: origin });
      expect(await c.closed, origin).toEqual({ code: 1008, reason: "bad origin" });
    }
  });

  it("allowedOrigins replaces the default list; requireOrigin rejects a missing Origin", async () => {
    await up({ allowedOrigins: ["https://app.example", /^https:\/\/[a-z]+\.dev\.example$/], requireOrigin: true });
    const ok = await connect(undefined, { Origin: "https://app.example" });
    ok.send({ control: { connect: stdioTarget() } });
    expect(await ok.next()).toEqual({ control: { connected: true } });
    ok.ws.close();
    const re = await connect(undefined, { Origin: "https://x.dev.example" });
    re.send({ control: { connect: stdioTarget() } });
    expect(await re.next()).toEqual({ control: { connected: true } });
    re.ws.close();
    expect(await (await connect(undefined, { Origin: "http://localhost:5173" })).closed).toEqual({ code: 1008, reason: "bad origin" });
    expect(await (await connect()).closed).toEqual({ code: 1008, reason: "bad origin" });
  });

  it("binds loopback only: a non-loopback address of this machine refuses the connection", async (ctx) => {
    const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return ctx.skip();
    await up();
    await expect(
      new Promise((res, rej) => { const w = new WebSocket(`ws://${lan.address}:${port}/?token=${TOKEN}`); w.once("open", res); w.once("error", rej); }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("bridge: stdio target lifecycle and framing", () => {
  it("connect -> connected ack -> {msg} frames both ways", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: stdioTarget() } });
    expect(await c.next()).toEqual({ control: { connected: true } });
    c.send(rpc(1, "tools/list", { a: 1 }));
    expect(await c.next()).toEqual({ msg: { jsonrpc: "2.0", id: 1, result: { echo: "tools/list", params: { a: 1 } } } });
    c.ws.close();
  });

  it("frames are JSON text; garbage and unknown frames are ignored and the socket stays open", async () => {
    await up();
    const c = await connect();
    c.ws.send("not json");
    c.send({ whatever: true });
    c.send(rpc(1, "ignored-before-connect")); // no target yet: dropped silently
    c.send({ control: { connect: stdioTarget() } });
    expect(await c.next()).toEqual({ control: { connected: true } }); // first frame back is the ack: nothing answered the junk
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  it("the target is chosen by the connect frame: command, args and env are used; the parent env is not forwarded", async () => {
    process.env.BRIDGE_TEST_SECRET = "s3cret";
    try {
      await up();
      const c = await connect();
      c.send({ control: { connect: stdioTarget({ env: { FOO: "bar" } }) } });
      await c.next();
      c.send(rpc(1, "env"));
      expect((await c.next()).msg.result).toEqual({ foo: "bar", secret: null });
      c.ws.close();
    } finally {
      delete process.env.BRIDGE_TEST_SECRET;
    }
  });

  it("a stdio target with no command, or a command that cannot spawn, yields a failed frame then closes the socket", async () => {
    await up();
    for (const spec of [{ transport: "stdio" }, stdioTarget({ command: "/nonexistent/definitely-not-a-binary", args: [] })]) {
      const c = await connect();
      c.send({ control: { connect: spec } });
      // a spawn failure may also surface as a bare {error} frame (transport onerror) before `failed`
      const f = await c.next((x) => x.control?.failed);
      expect(f.control).toEqual({ failed: true });
      expect(typeof f.error).toBe("string");
      expect((await c.closed).code).toBe(1005); // plain close() with no code
    }
  });

  it("an http target without a url fails the same way", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: { transport: "http" } } });
    const f = await c.next();
    expect(f).toMatchObject({ control: { failed: true }, error: "http target needs a url" });
    await c.closed;
  });

  it("allowTarget can refuse a target (opt-in command allowlist)", async () => {
    await up({ allowTarget: (t) => t.command === process.execPath && t.args?.[0] === FIXTURE });
    const denied = await connect();
    denied.send({ control: { connect: { transport: "stdio", command: "/bin/sh", args: ["-c", "echo hi"] } } });
    expect(await denied.next()).toMatchObject({ control: { failed: true }, error: "target not allowed" });
    await denied.closed;
    const ok = await connect();
    ok.send({ control: { connect: stdioTarget() } });
    expect(await ok.next()).toEqual({ control: { connected: true } });
    ok.ws.close();
  });

  it("{control:{close:true}} closes the target: a closed frame, then the socket closes", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: stdioTarget() } });
    await c.next();
    c.send({ control: { close: true } });
    expect(await c.next()).toEqual({ control: { closed: true } });
    await c.closed;
  });

  it("the target exiting on its own sends a closed frame and closes the socket", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: stdioTarget() } });
    await c.next();
    c.send(rpc(1, "exit"));
    expect(await c.next((f) => f.control?.closed)).toEqual({ control: { closed: true } });
    await c.closed;
  });

  it("closing the socket terminates the spawned process", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: stdioTarget() } });
    await c.next();
    c.send(rpc(1, "pid"));
    const pid: number = (await c.next()).msg.result.pid;
    expect(() => process.kill(pid, 0)).not.toThrow();
    c.ws.close();
    await c.closed;
    await expect.poll(() => { try { process.kill(pid, 0); return "alive"; } catch { return "gone"; } }, { timeout: 8000 }).toBe("gone");
  });

  it("proxy.close() drops open sockets", async () => {
    await up();
    const c = await connect();
    await proxy!.close();
    proxy = undefined;
    await c.closed;
  });
});

describe("bridge: http target", () => {
  let http: Server;
  let url = "";
  beforeAll(async () => {
    http = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const m = JSON.parse(body || "{}");
        if (m.id === undefined) return void res.writeHead(202).end();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { via: "http", method: m.method } }));
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  it("relays JSON-RPC to a Streamable HTTP server", async () => {
    await up();
    const c = await connect();
    c.send({ control: { connect: { transport: "http", url } } });
    expect(await c.next()).toEqual({ control: { connected: true } });
    c.send(rpc(7, "tools/list"));
    expect(await c.next()).toEqual({ msg: { jsonrpc: "2.0", id: 7, result: { via: "http", method: "tools/list" } } });
    c.ws.close();
  });
});
