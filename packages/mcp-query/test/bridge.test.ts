import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { WebSocket as WsClient } from "ws";
import { MCPClient } from "../src/index.js";
import { WebSocketBridgeTransport, MCP_CORS_ALLOW_HEADERS, MCP_CORS_EXPOSE_HEADERS, mcpCorsHeaders } from "../src/bridge/index.js";
import { startBridge, type BridgeHandle } from "../src/bridge/server.js";

const fixture = fileURLToPath(new URL("./fixtures/echo-stdio.mjs", import.meta.url));
const stdioTarget = { transport: "stdio" as const, command: process.execPath, args: [fixture] };

let bridge: BridgeHandle | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

const connectRaw = (url: string) =>
  new Promise<{ ws: WebSocket; closed: Promise<number> }>((resolve) => {
    const ws = new WebSocket(url);
    const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
    ws.addEventListener("open", () => resolve({ ws, closed }));
    ws.addEventListener("close", () => resolve({ ws, closed })); // rejected before open
  });

describe("WebSocket <-> stdio bridge (#63)", () => {
  it("an MCPClient talks to a stdio server through the bridge", async () => {
    bridge = await startBridge({ port: 0, token: "t0k" });
    const client = new MCPClient({
      servers: { echo: { transport: () => new WebSocketBridgeTransport(bridge!.url, "t0k", stdioTarget) } },
    });
    await client.connect();
    const res = (await client.callTool("echo", { msg: "hi" })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("echo:hi");
    await client.close();
  });

  it("rejects a wrong token (policy-violation close 1008)", async () => {
    bridge = await startBridge({ port: 0, token: "right" });
    const { closed } = await connectRaw(`${bridge.url}/?token=wrong`);
    expect(await closed).toBe(1008);
  });

  it("rejects a disallowed Origin and honours allowOrigins", async () => {
    bridge = await startBridge({ port: 0, token: "t", allowOrigins: ["https://app.example"] });
    const bad = new WsClient(`${bridge.url}/?token=t`, { origin: "https://evil.example" });
    expect(await new Promise((r) => bad.once("close", (code) => r(code)))).toBe(1008);
    const ok = new WsClient(`${bridge.url}/?token=t`, { origin: "https://app.example" });
    await new Promise<void>((r) => ok.once("open", () => r()));
    ok.close();
  });

  it("allowTarget can refuse a connect request; the client sees the failure", async () => {
    bridge = await startBridge({ port: 0, token: "t", allowTarget: (spec) => spec.transport === "http" });
    const t = new WebSocketBridgeTransport(bridge.url, "t", stdioTarget);
    await expect(t.start()).rejects.toThrow(/not allowed/);
  });

  it("a failing target reports the failure instead of hanging", async () => {
    bridge = await startBridge({ port: 0, token: "t" });
    const t = new WebSocketBridgeTransport(bridge.url, "t", { transport: "stdio", command: "/nonexistent-cmd-xyz" });
    await expect(t.start()).rejects.toThrow();
  });

  it("wire frames follow the documented protocol", async () => {
    bridge = await startBridge({ port: 0, token: "t" });
    const { ws } = await connectRaw(`${bridge.url}/?token=t`);
    const frames: any[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    ws.send(JSON.stringify({ control: { connect: stdioTarget } }));
    await expect.poll(() => frames.some((f) => f.control?.connected)).toBe(true);
    ws.send(JSON.stringify({ msg: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } } }));
    await expect.poll(() => frames.some((f) => f.msg?.id === 1 && f.msg?.result)).toBe(true);
    ws.send(JSON.stringify({ control: { close: true } }));
    await expect.poll(() => frames.some((f) => f.control?.closed)).toBe(true);
  });
});

describe("browser CORS contract for Streamable HTTP (#63)", () => {
  it("lists the headers the Streamable HTTP transport sends and reads", () => {
    for (const h of ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"]) {
      expect(MCP_CORS_ALLOW_HEADERS).toContain(h);
    }
    expect(MCP_CORS_EXPOSE_HEADERS).toContain("Mcp-Session-Id");
  });

  it("mcpCorsHeaders builds a response header set for an allowed origin", () => {
    expect(mcpCorsHeaders("https://app.example")).toEqual({
      "Access-Control-Allow-Origin": "https://app.example",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": MCP_CORS_ALLOW_HEADERS.join(", "),
      "Access-Control-Expose-Headers": MCP_CORS_EXPOSE_HEADERS.join(", "),
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    });
  });
});
