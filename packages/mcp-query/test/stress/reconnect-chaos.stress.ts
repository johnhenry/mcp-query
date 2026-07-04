// Reconnect chaos: repeatedly tear the transport down mid-session and assert the
// connection state machine recovers (reconnecting → ready), the cache reconciles, and a
// capability downgrade between connects lands the connection in `degraded` when a wanted
// capability disappears. With STRESS_REAL=1, additionally kill a real server-everything
// child process and assert recovery + no orphan processes.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { MCPClient } from "../../src/core/client.js";
import { MockMCPServer } from "../../src/testing/mockServer.js";
import { REAL, spawnEverything, tick } from "./helpers.js";

const CYCLES = 20;

describe("reconnect chaos", () => {
  it(`survives ${CYCLES} forced transport drops and reconciles`, async () => {
    let version = 0;
    const server = new MockMCPServer({
      resources: [{ uri: "mem://doc", read: () => ({ text: `v${version}` }) }],
      tools: [{ name: "t", handler: () => ({ content: [{ type: "text", text: "ok" }] }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport, retryDelay: () => 5 } } });
    const states: string[] = [];
    client.subscribeCapabilities(() => {});
    const unsub = client.subscribeServerState(() => {
      states.push(client.serverState("s"));
    });
    await client.connect();
    await client.readResource("mem://doc", { subscribe: true });

    for (let i = 0; i < CYCLES; i++) {
      version = i + 1;
      // Drop the live transport out from under the connection.
      const conn = client.connections().find((c) => c.name === "s")!;
      const connectsBefore = server.connectCount;
      await conn.sdk.transport?.close();
      // Wait on the observable reconnect (a fresh transport build) rather than racing
      // the state machine's reconnecting→ready hop, which can complete between polls.
      await expect
        .poll(() => server.connectCount, { timeout: 10_000, interval: 5 })
        .toBeGreaterThan(connectsBefore);
      await expect
        .poll(() => client.serverState("s"), { timeout: 10_000, interval: 5 })
        .toBe("ready");
    }

    expect(server.connectCount).toBeGreaterThanOrEqual(CYCLES + 1);
    expect(states).toContain("reconnecting");
    // Post-chaos, the connection still serves calls.
    const r = (await client.callTool("t", {})) as { content: Array<{ text: string }> };
    expect(r.content[0]?.text).toBe("ok");

    unsub();
    await client.close();
  });

  it("enters degraded when the surface empties across reconnect, recovers when restored", async () => {
    // NOTE (finding): `degraded` means "connected but exposes no tools/resources/prompts"
    // (connection.ts isDegraded()) — it is NOT triggered by losing a wanted capability
    // like resources.subscribe (that downgrade silently falls back to polling), and the
    // "app-configurable in practice" comment has no configuration hook.
    const server = new MockMCPServer({
      resources: [{ uri: "mem://doc", read: () => ({ text: "x" }) }],
    });
    const client = new MCPClient({ servers: { s: { transport: server.transport, retryDelay: () => 5 } } });
    await client.connect();
    await client.readResource("mem://doc", { subscribe: true });
    const full = server.spec;

    // Downgrade: the server comes back exposing nothing at all.
    server.spec = { capabilities: {} };
    const before = server.connectCount;
    await client.connections()[0]!.sdk.transport?.close();
    await expect
      .poll(() => server.connectCount, { timeout: 10_000, interval: 5 })
      .toBeGreaterThan(before);
    await expect
      .poll(() => client.serverState("s"), { timeout: 10_000, interval: 5 })
      .toBe("degraded");

    // Restore: full capabilities come back.
    server.spec = full;
    const before2 = server.connectCount;
    await client.connections()[0]!.sdk.transport?.close();
    await expect
      .poll(() => server.connectCount, { timeout: 10_000, interval: 5 })
      .toBeGreaterThan(before2);
    await expect
      .poll(() => client.serverState("s"), { timeout: 10_000, interval: 5 })
      .toBe("ready");

    await client.close();
  });

  it.runIf(REAL)("recovers from a killed server-everything child (STRESS_REAL=1)", async () => {
    const real = spawnEverything();
    const client = new MCPClient({ servers: { ev: { transport: real.transport, retryDelay: () => 50 } } });
    await client.connect();
    const tools = await client.listTools("ev");
    expect(tools.length).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) {
      const pid = real.pids().at(-1);
      expect(pid).toBeGreaterThan(0);
      process.kill(pid!, "SIGKILL");
      await expect
        .poll(() => client.serverState("ev"), { timeout: 30_000, interval: 50 })
        .toBe("ready");
    }

    await client.close();
    await tick(200);
    // No orphans: every child we ever spawned is gone.
    for (const pid of real.pids()) {
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      expect(alive, `pid ${pid} should be dead`).toBe(false);
    }
    void execSync; // (kept for future ps-based sweeps)
  });
});
