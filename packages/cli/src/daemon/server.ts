// The keep-alive daemon: a background process holding upstream MCP connections alive and
// serving CLI invocations over a unix socket. Successive `mcpq … --daemon <server>` reuse
// the SAME live upstream connection (important for slow/stateful stdio servers like a
// browser, which should NOT be re-spawned per call).
//
// The request-handling logic lives in `createHandler`, which is decoupled from sockets and
// spawning so it can be unit-tested directly against a MockMCPServer-backed upstream.

import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectClient, type ConnectOptions } from "../../../mcp-contract/src/index.js";
import type { JSONSchema } from "../../../mcp-contract/src/schema.js";
import { coerceArgs } from "../invoke.js";
import {
  DAEMON_DIR,
  LOG,
  PID,
  SOCK,
  readFrame,
  serverKey,
  writeFrame,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatus,
} from "./protocol.js";

type Upstream = { client: Client; close: () => Promise<void> };
type Connect = (opts: ConnectOptions) => Promise<Upstream>;

interface Entry {
  conn: Upstream;
  opts: ConnectOptions;
  lastUsed: number;
}

const IDLE_MS = Number(process.env.MCPQ_DAEMON_IDLE_MS) || 300_000;
const SELF_IDLE_MS = 10 * 60_000; // retire the daemon after this long with zero upstreams
const EVICT_INTERVAL_MS = 30_000;

function isTransportError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    m.includes("closed") ||
    m.includes("not connected") ||
    m.includes("disconnect") ||
    m.includes("transport") ||
    m.includes("epipe") ||
    m.includes("econnreset")
  );
}

/**
 * The pure-ish core: an upstream connection pool plus a per-request dispatcher. No sockets,
 * no spawning — `connect` is injectable so tests can supply a MockMCPServer-backed upstream
 * and assert reuse (connect is invoked once across repeated requests for the same key).
 */
export function createHandler(connect: Connect = connectClient) {
  const upstreams = new Map<string, Entry>();
  const startedAt = Date.now();

  async function getUpstream(opts: ConnectOptions): Promise<Entry> {
    const key = serverKey(opts);
    let entry = upstreams.get(key);
    if (!entry) {
      entry = { conn: await connect(opts), opts, lastUsed: Date.now() };
      upstreams.set(key, entry);
    }
    return entry;
  }

  async function dropUpstream(key: string): Promise<void> {
    const entry = upstreams.get(key);
    if (!entry) return;
    upstreams.delete(key);
    await entry.conn.close().catch(() => {});
  }

  /** Run an op against a tool client, reconnecting ONCE on a transport/closed error. */
  async function withClient<T>(opts: ConnectOptions, run: (c: Client) => Promise<T>): Promise<T> {
    const key = serverKey(opts);
    const entry = await getUpstream(opts);
    try {
      const out = await run(entry.conn.client);
      entry.lastUsed = Date.now();
      return out;
    } catch (err) {
      if (!isTransportError(err)) throw err;
      await dropUpstream(key);
      const fresh = await getUpstream(opts);
      const out = await run(fresh.conn.client);
      fresh.lastUsed = Date.now();
      return out;
    }
  }

  async function runOp(req: DaemonRequest): Promise<unknown> {
    if (req.op === "status") {
      const now = Date.now();
      const status: DaemonStatus = {
        uptimeMs: now - startedAt,
        servers: [...upstreams.values()].map((e) => ({ key: serverKey(e.opts), idleMs: now - e.lastUsed })),
      };
      return status;
    }
    if (!req.opts) throw new Error(`op "${req.op}" requires connection opts`);
    const opts = req.opts;
    switch (req.op) {
      case "tools":
        return withClient(opts, async (c) => (await c.listTools()).tools);
      case "call": {
        if (!req.tool) throw new Error("call requires a tool name");
        return withClient(opts, async (c) => {
          const { tools } = await c.listTools();
          const def = tools.find((t) => t.name === req.tool);
          const schema = def?.inputSchema as JSONSchema | undefined;
          const args = coerceArgs(schema, req.args ?? {});
          return c.callTool({ name: req.tool!, arguments: args });
        });
      }
      case "read": {
        if (!req.uri) throw new Error("read requires a uri");
        return withClient(opts, (c) => c.readResource({ uri: req.uri! }));
      }
      case "prompt": {
        if (!req.name) throw new Error("prompt requires a name");
        const args: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.args ?? {})) args[k] = typeof v === "string" ? v : JSON.stringify(v);
        return withClient(opts, (c) => c.getPrompt({ name: req.name!, arguments: args }));
      }
      case "ping": {
        return withClient(opts, async (c) => {
          const started = Date.now();
          await c.ping();
          return { ms: Date.now() - started };
        });
      }
      default:
        throw new Error(`unknown op "${(req as DaemonRequest).op}"`);
    }
  }

  /** Handle one request, never throwing: always resolves to a response frame. */
  async function handle(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      return { ok: true, result: await runOp(req) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function closeAll(): Promise<void> {
    const entries = [...upstreams.values()];
    upstreams.clear();
    await Promise.all(entries.map((e) => e.conn.close().catch(() => {})));
  }

  /** Evict idle upstreams; report whether ALL upstreams are gone (for self-retire). */
  async function evictIdle(idleMs = IDLE_MS): Promise<{ empty: boolean }> {
    const now = Date.now();
    for (const [key, entry] of [...upstreams.entries()]) {
      if (now - entry.lastUsed > idleMs) await dropUpstream(key);
    }
    return { empty: upstreams.size === 0 };
  }

  return { handle, closeAll, evictIdle, get size() { return upstreams.size; }, startedAt };
}

export type Handler = ReturnType<typeof createHandler>;

function log(line: string): void {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never crash the daemon */
  }
}

/** Try to connect to an existing socket; resolve true if something answers. */
function probe(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(SOCK);
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * Run the daemon: bind the socket atomically, serve requests until stopped, evict idle
 * upstreams, and self-retire after a long fully-idle window. Exits 0 if another daemon
 * already owns the socket (lost the startup race).
 */
export async function runDaemon(): Promise<void> {
  mkdirSync(DAEMON_DIR, { recursive: true });
  const handler = createHandler();
  let lastEmptyAt = Date.now();

  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    void (async () => {
      try {
        const req = await readFrame<DaemonRequest>(sock);
        if (req.op === "stop") {
          log("stop requested");
          await writeFrame(sock, { ok: true, result: { stopped: true } } satisfies DaemonResponse).catch(() => {});
          sock.end();
          await shutdown(0);
          return;
        }
        const res = await handler.handle(req);
        await writeFrame(sock, res);
        sock.end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A client that connected but never sent a frame is just a liveness probe
        // (`isRunning`) — not an error, and there's nothing to reply to.
        if (msg.includes("before a full frame")) {
          sock.end();
          return;
        }
        log(`request error: ${msg}`);
        await writeFrame(sock, { ok: false, error: msg } satisfies DaemonResponse).catch(() => {});
        sock.end();
      }
    })();
  });

  async function shutdown(code: number): Promise<void> {
    try {
      await handler.closeAll();
    } catch {
      /* ignore */
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
    safeUnlink(SOCK);
    safeUnlink(PID);
    log(`shutdown (code ${code})`);
    process.exit(code);
  }

  // Atomic bind; on EADDRINUSE distinguish a live daemon (lost the race → exit 0) from a
  // stale socket left by a crash (unlink + rebind).
  await new Promise<void>((resolve, reject) => {
    const onError = async (err: NodeJS.ErrnoException): Promise<void> => {
      if (err.code !== "EADDRINUSE") return reject(err);
      if (await probe()) {
        log("another daemon already running — exiting");
        process.exit(0);
      }
      safeUnlink(SOCK); // stale socket from a crashed daemon
      server.once("error", reject);
      server.listen(SOCK, resolve);
    };
    server.once("error", onError);
    server.listen(SOCK, resolve);
  });

  writeFileSync(PID, String(process.pid));
  log(`listening on ${SOCK} (pid ${process.pid})`);

  const timer = setInterval(() => {
    void (async () => {
      const { empty } = await handler.evictIdle();
      if (empty) {
        if (Date.now() - lastEmptyAt > SELF_IDLE_MS) {
          log("idle with no upstreams — self-retiring");
          await shutdown(0);
        }
      } else {
        lastEmptyAt = Date.now();
      }
    })();
  }, EVICT_INTERVAL_MS);
  timer.unref();

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}
