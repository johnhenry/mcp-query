// Local proxy: bridges the browser (WebSocket) to MCP servers over stdio / Streamable
// HTTP / SSE. This is the one piece mcp-query deliberately leaves out (browser-stdio
// bridge). Security: random bearer token, localhost-only bind, Origin check.

import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface TargetSpec {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

const PORT = Number(process.env.PROXY_PORT ?? 6280);
const WEB = process.env.WEB_URL ?? "http://localhost:5173";
const TOKEN = process.env.PROXY_TOKEN ?? randomUUID();

function makeTarget(spec: TargetSpec): Transport {
  if (spec.transport === "stdio") {
    if (!spec.command) throw new Error("stdio target needs a command");
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
    });
  }
  if (!spec.url) throw new Error(`${spec.transport} target needs a url`);
  return spec.transport === "sse"
    ? new SSEClientTransport(new URL(spec.url))
    : new StreamableHTTPClientTransport(new URL(spec.url));
}

const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.searchParams.get("token") !== TOKEN) return ws.close(1008, "bad token");
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return ws.close(1008, "bad origin");

  let target: Transport | undefined;
  const sendJson = (o: unknown) => { try { ws.send(JSON.stringify(o)); } catch { /* socket gone */ } };

  ws.on("message", async (data) => {
    let frame: { control?: { connect?: TargetSpec; close?: boolean }; msg?: unknown };
    try { frame = JSON.parse(data.toString()); } catch { return; }

    if (frame.control?.connect) {
      try {
        target = makeTarget(frame.control.connect);
        target.onmessage = (m) => sendJson({ msg: m });
        target.onclose = () => { sendJson({ control: { closed: true } }); ws.close(); };
        target.onerror = (e) => sendJson({ error: e instanceof Error ? e.message : String(e) });
        await target.start();
        sendJson({ control: { connected: true } });
      } catch (e) {
        sendJson({ error: e instanceof Error ? e.message : String(e), control: { failed: true } });
        ws.close();
      }
    } else if (frame.control?.close) {
      await target?.close().catch(() => {});
    } else if (frame.msg !== undefined) {
      await target?.send(frame.msg as never).catch((e) => sendJson({ error: String(e) }));
    }
  });

  ws.on("close", () => void target?.close().catch(() => {}));
});

console.log(`\n  ⬡ MCP Inspector proxy  ws://127.0.0.1:${PORT}`);
console.log(`  → Open:  ${WEB}/?proxyToken=${TOKEN}\n`);
