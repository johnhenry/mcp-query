// Node reference implementation of the WebSocket <-> MCP bridge (#63); protocol in ./protocol.ts.
// Needs the optional peer `ws`. Security defaults: binds 127.0.0.1, requires a bearer token
// (`?token=`), and accepts only localhost Origins. A connect frame makes this process spawn
// a command, so for anything beyond a local dev tool pass `allowTarget` (an allowlist) and
// keep `allowOrigins` explicit.

import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport, SSEClientTransport, type Transport } from "@modelcontextprotocol/client";
import type { TargetSpec } from "./protocol.js";

export type { TargetSpec } from "./protocol.js";

export interface BridgeOptions {
  /** Port to bind. 0 picks a free port (read it from `handle.url`). Default 6280. */
  port?: number;
  /** Interface to bind. Default "127.0.0.1". */
  host?: string;
  /** Bearer token clients present as `?token=`. Default: a random UUID (returned on the handle). */
  token?: string;
  /** Exact Origin values to accept. Default: any http://localhost or http://127.0.0.1 origin. A request with no Origin header is accepted. */
  allowOrigins?: string[];
  /** Gate every connect request; return false to refuse it ("target not allowed"). Default: allow all. */
  allowTarget?: (spec: TargetSpec) => boolean | Promise<boolean>;
}

export interface BridgeHandle {
  /** ws://<host>:<port> */
  url: string;
  token: string;
  close(): Promise<void>;
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

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
  return spec.transport === "sse" ? new SSEClientTransport(new URL(spec.url)) : new StreamableHTTPClientTransport(new URL(spec.url));
}

export function startBridge(opts: BridgeOptions = {}): Promise<BridgeHandle> {
  const port = opts.port ?? 6280;
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomUUID();
  const wss = new WebSocketServer({ port, host });

  wss.on("connection", (ws: WsSocket, req) => {
    const given = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
    if (!safeEqual(given, token)) return ws.close(1008, "bad token");
    const origin = req.headers.origin;
    if (origin && !(opts.allowOrigins ? opts.allowOrigins.includes(origin) : LOCAL_ORIGIN.test(origin))) {
      return ws.close(1008, "bad origin");
    }

    let target: Transport | undefined;
    const sendJson = (o: unknown) => {
      try {
        ws.send(JSON.stringify(o));
      } catch {
        // socket gone
      }
    };
    const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

    const handle = async (data: string) => {
      let frame: { control?: { connect?: TargetSpec; close?: boolean }; msg?: unknown };
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (frame.control?.connect) {
        if (target) return; // connect is once per socket
        const spec = frame.control.connect;
        try {
          if (opts.allowTarget && !(await opts.allowTarget(spec))) throw new Error("target not allowed");
          const t = makeTarget(spec);
          target = t;
          t.onmessage = (m) => sendJson({ msg: m });
          t.onclose = () => {
            sendJson({ control: { closed: true } });
            ws.close();
          };
          t.onerror = (e) => sendJson({ error: errText(e) });
          await t.start();
          sendJson({ control: { connected: true } });
        } catch (e) {
          target = undefined;
          sendJson({ control: { failed: true }, error: errText(e) });
          ws.close();
        }
      } else if (frame.control?.close) {
        await target?.close().catch(() => {});
      } else if (frame.msg !== undefined) {
        await target?.send(frame.msg as never).catch((e) => sendJson({ error: errText(e) }));
      }
    };

    // Process frames strictly in order so a message sent right after `connect` cannot overtake the dial.
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (data) => {
      const text = data.toString();
      chain = chain.then(() => handle(text));
    });
    ws.on("close", () => void target?.close().catch(() => {}));
  });

  return new Promise<BridgeHandle>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const addr = wss.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        url: `ws://${host}:${boundPort}`,
        token,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}
