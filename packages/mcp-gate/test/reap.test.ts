// #23: close() must not resolve until every spawned stdio child has actually exited, even
// a child that ignores SIGTERM (and EOF on stdin).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createGate } from "../src/index.js";
import { resolveUpstream } from "../src/upstream.js";

const fixture = fileURLToPath(new URL("./fixtures/stubborn-server.mjs", import.meta.url));

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Pidded = { pid: number | undefined };

// pids of live fixture processes carrying this run's marker arg
const livePids = (marker: string): number[] =>
  spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);

describe("child process reaping (#23)", () => {
  it("transport.close() resolves only after a SIGTERM-ignoring child has exited", async () => {
    const cfg = resolveUpstream({ command: process.execPath, args: [fixture] });
    const transport = cfg.transport() as unknown as Pidded & { start(): Promise<void>; close(): Promise<void> };
    await transport.start();
    const pid = transport.pid!;
    expect(alive(pid)).toBe(true);
    await transport.close();
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it("gate.close() reaps every spawned stdio child, including removed/replaced upstreams", async () => {
    const marker = `reap-marker-${randomUUID()}`;
    const up = { command: process.execPath, args: [fixture, marker] };
    const gate = await createGate({ audit: () => {}, upstreams: { a: up } });
    await gate.addUpstream("b", up);
    await gate.updateUpstream("b", up); // removes + re-adds
    await gate.removeUpstream("a");
    await gate.addUpstream("c", up);
    const pids = livePids(marker);
    expect(pids.length).toBe(2); // b, c
    await gate.close();
    expect(pids.filter(alive)).toEqual([]); // checked immediately: close() itself must have awaited exit
  }, 60_000);
});
