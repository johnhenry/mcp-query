// Reusable local proxy: bridges the browser (WebSocket) to MCP servers over stdio /
// Streamable HTTP / SSE. This is the one piece mcp-query deliberately leaves out
// (browser-stdio bridge). Security: random bearer token, localhost-only bind, Origin
// check. Framework-agnostic — each app's dev script spins this up via proxy-cli.ts.

import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport, SSEClientTransport, type Transport } from "@modelcontextprotocol/client";

/** How an app (or the browser) declares a server for the proxy to dial. */
export interface TargetSpec {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Connect directly from the browser (http/sse) so OAuth runs + is observable there. */
  direct?: boolean;
}

/**
 * One allowlist entry. `command` and each `args` item must match exactly, except an item may be
 * `{ endsWith }` or `{ any: true }`. `args` must have the same length as the request's (omitted =
 * no args). A request carrying `env` is refused unless the rule sets `allowEnv`.
 * http/sse: set `transport` and `url` (exact match).
 */
export interface TargetRule {
  transport?: TargetSpec["transport"];
  command?: string;
  args?: Array<string | { endsWith: string } | { any: true }>;
  url?: string;
  allowEnv?: boolean;
}

/** True when `spec` satisfies `rule` (see {@link TargetRule}). */
export function targetMatchesRule(spec: TargetSpec, rule: TargetRule): boolean {
  if ((rule.transport ?? "stdio") !== spec.transport) return false;
  if (spec.transport === "stdio") {
    if (!rule.command || rule.command !== spec.command) return false;
    const want = rule.args ?? [];
    const got = spec.args ?? [];
    if (want.length !== got.length) return false;
    const ok = want.every((w, i) => {
      const g = got[i];
      if (typeof g !== "string") return false;
      return typeof w === "string" ? w === g : "endsWith" in w ? g.endsWith(w.endsWith) : true;
    });
    if (!ok) return false;
    if (spec.env && Object.keys(spec.env).length > 0 && !rule.allowEnv) return false;
    return true;
  }
  return !!rule.url && rule.url === spec.url;
}

export interface StartProxyOptions {
  /** WebSocket port to bind on 127.0.0.1. Default: PROXY_PORT env or 6280. */
  port?: number;
  /** Bearer token clients must present as `?token=`. Default: PROXY_TOKEN env or a random UUID. */
  token?: string;
  /** Web app URL, used only for the printed connect hint. Default: WEB_URL env or http://localhost:5173. */
  webUrl?: string;
  /**
   * Origins allowed to open a socket (exact strings or RegExps tested against the `Origin`
   * header). Default: loopback origins only: `http://localhost`, `http://127.0.0.1`,
   * `http://[::1]`, any port.
   */
  allowedOrigins?: Array<string | RegExp>;
  /** Refuse sockets that send no `Origin` header (non-browser clients). Default true; pass false to opt out. */
  requireOrigin?: boolean;
  /**
   * Explicit allowlist of what a client may ask the proxy to dial. A `connect` is accepted when it
   * matches ANY rule here or `allowTarget` returns true. With neither configured (and no
   * `allowAnyTarget`) every target is refused: nothing is spawned or dialed by default.
   */
  allowTargets?: TargetRule[];
  /** Predicate form of the allowlist, for rules a `TargetRule` cannot express. */
  allowTarget?: (spec: TargetSpec) => boolean;
  /**
   * UNSAFE escape hatch: accept any target a token holder asks for, i.e. let the page run any
   * local command with any args and env. A warning is logged at startup. Only for dev tools whose
   * whole job is to launch whatever the user types.
   */
  allowAnyTarget?: boolean;
}

export interface ProxyHandle {
  /** ws://127.0.0.1:<port> */
  url: string;
  /** The bearer token clients must present. */
  token: string;
  /** Shut the proxy down. */
  close: () => Promise<void>;
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
  return spec.transport === "sse"
    ? new SSEClientTransport(new URL(spec.url))
    : new StreamableHTTPClientTransport(new URL(spec.url));
}

/**
 * Start the WebSocket↔MCP bridge. Resolves once the server is listening, returning the
 * connect url + token + a close() handle.
 */
export function startProxy(opts: StartProxyOptions = {}): Promise<ProxyHandle> {
  const port = opts.port ?? Number(process.env.PROXY_PORT ?? 6280);
  const token = opts.token ?? process.env.PROXY_TOKEN ?? randomUUID();

  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const originAllowed = (origin: string) =>
    opts.allowedOrigins
      ? opts.allowedOrigins.some((o) => (typeof o === "string" ? o === origin : o.test(origin)))
      : /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  const requireOrigin = opts.requireOrigin ?? true;
  const targetAllowed = (spec: TargetSpec) =>
    opts.allowAnyTarget === true ||
    !!opts.allowTargets?.some((r) => targetMatchesRule(spec, r)) ||
    opts.allowTarget?.(spec) === true;
  if (opts.allowAnyTarget) {
    console.warn("[mcp-query proxy] WARNING: allowAnyTarget is set. Any holder of the token can run ANY local command through this proxy.");
  }

  wss.on("connection", (ws: WebSocket, req) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.searchParams.get("token") !== token) return ws.close(1008, "bad token");
    const origin = req.headers.origin;
    if (!origin ? requireOrigin : !originAllowed(origin)) return ws.close(1008, "bad origin");

    let target: Transport | undefined;
    const sendJson = (o: unknown) => { try { ws.send(JSON.stringify(o)); } catch { /* socket gone */ } };

    ws.on("message", async (data) => {
      let frame: { control?: { connect?: TargetSpec; close?: boolean }; msg?: unknown };
      try { frame = JSON.parse(data.toString()); } catch { return; }

      if (frame.control?.connect) {
        try {
          if (!targetAllowed(frame.control.connect)) throw new Error("target not allowed");
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

  return new Promise<ProxyHandle>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      resolve({
        url: `ws://127.0.0.1:${port}`,
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
