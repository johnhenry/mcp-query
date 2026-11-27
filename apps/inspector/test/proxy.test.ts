// The inspector runs the shared hardened proxy (apps/shared/src/proxy-cli.ts) with its own
// proxy-allow.json. This pins the inspector's actual dev entrypoint end to end: real CLI process,
// real `ws` clients, real stdio children. The shared protocol cases live in apps/shared/test.
// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const APP = fileURLToPath(new URL("..", import.meta.url));
const CLI = "../shared/src/proxy-cli.ts";
const TOKEN = "inspector-test-token";
const BROWSER = { Origin: "http://localhost:5173" };
const HOLD = { transport: "stdio", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] };
const DEMO = { transport: "stdio", command: "npx", args: ["tsx", "fixtures/mcp-app-demo.ts"] };

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let child: ChildProcess | undefined;
let port = 0;
let output = "";
async function up(env: Record<string, string> = {}) {
  port = await freePort();
  output = "";
  const bin = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
  child = spawn(bin, [CLI], { cwd: APP, env: { ...process.env, PROXY_PORT: String(port), PROXY_TOKEN: TOKEN, PROXY_ALLOW_ANY: "", ...env } });
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  const deadline = Date.now() + 30_000;
  while (!output.includes("Open:")) {
    if (Date.now() > deadline) throw new Error(`proxy did not start: ${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
afterEach(async () => {
  child?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 100));
  child = undefined;
});

/** Open a socket and resolve with the first frame or the close, whichever comes first. */
function attempt(opts: { query?: string; headers?: Record<string, string>; connect?: unknown }) {
  return new Promise<{ closed?: { code: number; reason: string }; frame?: any }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${opts.query ?? `?token=${TOKEN}`}`, { headers: opts.headers ?? BROWSER });
    const timer = setTimeout(() => reject(new Error("timed out")), 15_000);
    ws.on("open", () => { if (opts.connect) ws.send(JSON.stringify({ control: { connect: opts.connect } })); });
    ws.on("message", (d) => { clearTimeout(timer); const frame = JSON.parse(d.toString()); ws.close(); resolve({ frame }); });
    ws.on("close", (code, reason) => { clearTimeout(timer); resolve({ closed: { code, reason: reason.toString() } }); });
    ws.on("error", reject);
  });
}

describe("inspector proxy (restricted: dev:proxy:restricted)", () => {
  it("accepts the bundled demo server from proxy-allow.json", async () => {
    await up();
    const r = await attempt({ connect: DEMO });
    expect(r.frame).toEqual({ control: { connected: true } });
  }, 60_000);

  it("denies any other target by default", async () => {
    await up();
    const r = await attempt({ connect: HOLD });
    expect(r.frame).toEqual({ error: "target not allowed", control: { failed: true } });
    // a near miss on the demo rule (different args) is refused too
    const r2 = await attempt({ connect: { ...DEMO, args: ["tsx", "fixtures/other.ts"] } });
    expect(r2.frame).toEqual({ error: "target not allowed", control: { failed: true } });
  }, 60_000);

  it("refuses a wrong token, a missing Origin and a non-loopback Origin", async () => {
    await up();
    expect((await attempt({ query: "?token=nope" })).closed).toEqual({ code: 1008, reason: "bad token" });
    expect((await attempt({ headers: {} })).closed).toEqual({ code: 1008, reason: "bad origin" });
    expect((await attempt({ headers: { Origin: "https://evil.example" } })).closed).toEqual({ code: 1008, reason: "bad origin" });
    expect((await attempt({ headers: { Origin: "http://localhost.evil.example" } })).closed).toEqual({ code: 1008, reason: "bad origin" });
  }, 60_000);
});

describe("inspector proxy (opt-in: dev:proxy, PROXY_ALLOW_ANY=1)", () => {
  it("allows an arbitrary command and warns at startup", async () => {
    await up({ PROXY_ALLOW_ANY: "1" });
    expect(output).toContain("WARNING: allowAnyTarget is set");
    const r = await attempt({ connect: HOLD });
    expect(r.frame).toEqual({ control: { connected: true } });
  }, 60_000);

  it("still enforces token and Origin", async () => {
    await up({ PROXY_ALLOW_ANY: "1" });
    expect((await attempt({ query: "?token=nope" })).closed?.reason).toBe("bad token");
    expect((await attempt({ headers: {} })).closed?.reason).toBe("bad origin");
  }, 60_000);
});
