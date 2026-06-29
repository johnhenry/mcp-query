// Wire protocol + shared paths for the `mcpq` keep-alive daemon.
//
// The daemon holds upstream MCP connections alive and serves CLI invocations over a local
// unix socket. ONE REQUEST PER SOCKET CONNECTION: socket connections are short-lived (one
// request each); only the UPSTREAM MCP connections persist, so there is no multiplexing or
// correlation-id bookkeeping. Each frame is a single newline-delimited JSON object.

import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { ConnectOptions } from "../../../mcp-contract/src/index.js";

/** Base directory holding the socket, pid file, and log. */
export const DAEMON_DIR = join(homedir(), ".mcp-query");
export const SOCK = join(DAEMON_DIR, "daemon.sock");
export const PID = join(DAEMON_DIR, "daemon.pid");
export const LOG = join(DAEMON_DIR, "daemon.log");

/**
 * Stable key identifying an upstream MCP connection. URL servers key on the url; stdio
 * servers key on the command + args. Two requests resolving to the same opts share one
 * live upstream connection.
 */
export function serverKey(opts: ConnectOptions): string {
  return opts.url ?? `stdio:${opts.command ?? ""} ${opts.args ?? ""}`;
}

/** A single request frame from the CLI client to the daemon. */
export interface DaemonRequest {
  op: "tools" | "call" | "read" | "prompt" | "ping" | "status" | "stop";
  /** Connection target (omitted for control ops `status`/`stop`). */
  opts?: ConnectOptions;
  /** `call`: tool name. */
  tool?: string;
  /** `call`/`prompt`: argument map (flag-style strings are coerced server-side). */
  args?: Record<string, unknown>;
  /** `read`: resource uri. */
  uri?: string;
  /** `prompt`: prompt name. */
  name?: string;
}

/** The daemon's reply: either an `ok` result payload or an error string. */
export type DaemonResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** Reported by `op: "status"`. */
export interface DaemonStatus {
  uptimeMs: number;
  servers: Array<{ key: string; idleMs: number }>;
}

/** Write exactly one newline-delimited JSON frame and resolve when flushed. */
export function writeFrame(sock: Socket, frame: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    sock.write(`${JSON.stringify(frame)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Read exactly one newline-delimited JSON frame from a socket. Resolves with the parsed
 * value on the first newline; rejects on a closed/errored socket before a full line, or on
 * malformed JSON.
 */
export function readFrame<T = unknown>(sock: Socket): Promise<T> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      sock.off("data", onData);
      sock.off("error", onErr);
      sock.off("close", onClose);
      fn();
    };
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      finish(() => {
        try {
          resolve(JSON.parse(line) as T);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    };
    const onErr = (err: Error): void => finish(() => reject(err));
    const onClose = (): void => finish(() => reject(new Error("socket closed before a full frame")));
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("close", onClose);
  });
}
