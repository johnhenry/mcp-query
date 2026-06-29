// The CLI client side of the daemon: spawn it on demand and talk to it over the unix
// socket. ONE REQUEST PER SOCKET CONNECTION — connect, write one frame, read one frame.
//
// `ensureDaemon` lazily spawns the daemon DETACHED + unref'd so the foreground `mcpq`
// process can exit while the daemon keeps upstream connections alive for the next call.

import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DAEMON_DIR,
  LOG,
  SOCK,
  readFrame,
  writeFrame,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatus,
} from "./protocol.js";

/** True if a daemon answers on the socket right now. */
export function isRunning(): Promise<boolean> {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn the daemon if it isn't already up, and wait until it answers (~5s budget). */
export async function ensureDaemon(): Promise<void> {
  if (await isRunning()) return;
  mkdirSync(DAEMON_DIR, { recursive: true });
  // A leftover socket file that nothing answers on is stale — remove it so the daemon can
  // rebind. (The daemon also handles this defensively, but unlinking here avoids a race.)
  if (existsSync(SOCK)) {
    const { unlinkSync } = await import("node:fs");
    try {
      unlinkSync(SOCK);
    } catch {
      /* ignore */
    }
  }

  const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
  const fd = openSync(LOG, "a");
  const child = spawn(process.execPath, ["--import", "tsx", mainPath], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();

  // Poll until it comes up (50ms × ~100 = ~5s).
  for (let i = 0; i < 100; i++) {
    if (await isRunning()) return;
    await sleep(50);
  }
  throw new Error("daemon failed to start within 5s (see ~/.mcp-query/daemon.log)");
}

/**
 * Send ONE request frame and read ONE response frame. Non-control ops autostart the daemon;
 * `status`/`stop` never do (a synthetic response stands in when nothing is running).
 */
export async function request(req: DaemonRequest, { autostart = true }: { autostart?: boolean } = {}): Promise<DaemonResponse> {
  if (autostart) await ensureDaemon();
  return new Promise<DaemonResponse>((resolve, reject) => {
    const sock = net.connect(SOCK);
    sock.once("error", reject);
    sock.once("connect", () => {
      void writeFrame(sock, req)
        .then(() => readFrame<DaemonResponse>(sock))
        .then((res) => {
          sock.end();
          resolve(res);
        })
        .catch(reject);
    });
  });
}

/** `status` without autostart — returns a synthetic "not running" if the daemon is down. */
export async function daemonStatus(): Promise<{ running: boolean; status?: DaemonStatus; error?: string }> {
  if (!(await isRunning())) return { running: false };
  const res = await request({ op: "status" }, { autostart: false });
  if (res.ok) return { running: true, status: res.result as DaemonStatus };
  return { running: true, error: res.error };
}

/** `stop` without autostart — no-op if nothing is running. Waits for the daemon to exit. */
export async function daemonStop(): Promise<{ stopped: boolean }> {
  if (!(await isRunning())) return { stopped: false };
  try {
    await request({ op: "stop" }, { autostart: false });
  } catch {
    // The daemon closes the socket as it exits; a read/close error here is expected.
  }
  // Wait for the daemon (and its upstream children) to actually go away, so callers/tests
  // don't race the shutdown (~3s budget).
  for (let i = 0; i < 60; i++) {
    if (!(await isRunning())) break;
    await sleep(50);
  }
  return { stopped: true };
}

/** `start` — explicitly bring the daemon up (idempotent). */
export async function daemonStart(): Promise<void> {
  await ensureDaemon();
}
