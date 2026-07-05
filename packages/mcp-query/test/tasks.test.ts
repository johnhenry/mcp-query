// MCP tasks (spec 2025-11-25, SDK experimental): call-now, fetch-later tool calls.
// End-to-end through MockMCPServer's task support: callToolTask handles, live status via
// the cache, results, cancellation, listing, capability gating, and status pushes.

import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import type { Task } from "../src/core/types.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function taskServer() {
  return new MockMCPServer({
    tools: [
      {
        name: "crunch",
        task: true,
        taskDelayMs: 40,
        handler: (args) => ({ content: [{ type: "text", text: `crunched ${args.n}` }] }),
      },
      {
        name: "explode",
        task: true,
        taskDelayMs: 10,
        handler: () => {
          throw new Error("boom");
        },
      },
      { name: "plain", handler: () => ({ content: [{ type: "text", text: "sync" }] }) },
    ],
  });
}

describe("callToolTask", () => {
  it("returns a handle immediately, streams status into the cache, and resolves the result", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const handle = await client.callToolTask("crunch", { n: 7 });
    expect(handle.taskId).toBeTruthy();
    expect(handle.server).toBe("s");
    // The creation snapshot is already in the cache.
    expect(handle.task()?.status).toBe("working");

    const seen: string[] = [];
    const unsub = handle.subscribe((t) => seen.push(t.status));

    const result = (await handle.result()) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("crunched 7");

    // The cache snapshot converges on a terminal status (via the stream's polling).
    await expect.poll(() => handle.task()?.status, { timeout: 5_000 }).toBe("completed");
    expect(seen).toContain("completed");
    unsub();
    await client.close();
  });

  it("rejects the result when the task fails", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const handle = await client.callToolTask("explode", {});
    // A failed task surfaces via the result promise (SDK raises on terminal failure) or
    // via an isError result — accept either, but the status must land on "failed".
    await handle.result().catch(() => {});
    await expect.poll(() => handle.task()?.status, { timeout: 5_000 }).toBe("failed");
    await client.close();
  });

  it("refuses task calls to servers without the tasks capability", async () => {
    const plain = new MockMCPServer({ tools: [{ name: "t", handler: () => ({ content: [] }) }] });
    const client = new MCPClient({ servers: { p: { transport: plain.transport } } });
    await client.connect();
    await expect(client.callToolTask("t", {})).rejects.toMatchObject({
      message: expect.stringContaining("tasks capability"),
    });
    await client.close();
  });

  it("supports('tasks') reflects the advertised capability", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    expect(client.connections()[0]!.supports("tasks")).toBe(true);
    await client.close();
  });
});

describe("task management", () => {
  it("getTask + listTasks see started tasks; cancelTask reaches a terminal state", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const slow = await client.callToolTask("crunch", { n: 1 }, { task: { ttl: 60_000 } });
    const listed = await client.listTasks("s");
    expect(listed.map((t) => t.taskId)).toContain(slow.taskId);

    const fetched = await client.getTask(slow.taskId, "s");
    expect(fetched.taskId).toBe(slow.taskId);

    await slow.cancel().catch(() => {}); // may already be completing — either way terminal
    await expect
      .poll(async () => (await client.getTask(slow.taskId, "s")).status, { timeout: 5_000 })
      .toMatch(/cancelled|completed/);
    await client.close();
  });

  it("getTaskResult retrieves a completed task's result", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const handle = await client.callToolTask("crunch", { n: 9 });
    await handle.result();
    const replay = (await client.getTaskResult(handle.taskId, "s")) as { content: Array<{ text: string }> };
    expect(replay.content[0]?.text).toBe("crunched 9");
    await client.close();
  });
});

describe("status pushes (notifications/tasks/status)", () => {
  it("writes pushed snapshots into the cache for tasks the client never started", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const pushed: Task = {
      taskId: "external-1",
      status: "working",
      ttl: null,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      statusMessage: "started elsewhere",
    };
    await server.notifyTaskStatus(pushed as unknown as Record<string, unknown>);
    await tick(30);

    const snap = client.cache.getSnapshot({ kind: "task", server: "s", taskId: "external-1" });
    expect((snap?.data as Task | undefined)?.statusMessage).toBe("started elsewhere");
    await client.close();
  });
});
