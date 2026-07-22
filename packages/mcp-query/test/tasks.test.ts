// Tasks on the `io.modelcontextprotocol/tasks` extension (SEP-2663): call-now,
// fetch-later tool calls. End-to-end through MockMCPServer's task support:
// server-directed task creation, poll-driven handles, results, cancellation,
// mid-flight input via tasks/update, capability gating, and status pushes.
//
// Era note: the v2 SDK has no tasks-extension runtime on the modern era, so
// mcp-query drives the extension on LEGACY-era connections only — all mocks here
// pin `era: "legacy"`, and one canary test asserts the modern-era fail-fast
// (it flips when the SDK ships the runtime).

import { describe, it, expect } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { MockMCPServer } from "../src/testing/mockServer.js";
import { InteractionBroker } from "../src/core/interactions.js";
import type { Task } from "../src/core/types.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function taskServer(era: "legacy" | "modern" | "both" = "legacy") {
  return new MockMCPServer(
    {
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
    },
    { era },
  );
}

describe("callToolTask", () => {
  it("returns a handle immediately, polls status into the cache, and resolves the result", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } }, taskPollMs: 15 });
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

    // The cache snapshot converges on a terminal status (via the handle's polling).
    await expect.poll(() => handle.task()?.status, { timeout: 5_000 }).toBe("completed");
    expect(seen).toContain("completed");
    unsub();
    await client.close();
    await server.close();
  });

  it("rejects the result when the task fails", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } }, taskPollMs: 15 });
    await client.connect();

    const handle = await client.callToolTask("explode", {});
    await expect(handle.result()).rejects.toMatchObject({ message: expect.stringContaining("boom") });
    await expect.poll(() => handle.task()?.status, { timeout: 5_000 }).toBe("failed");
    await client.close();
    await server.close();
  });

  it("returns an already-completed handle when the server chooses synchronous execution", async () => {
    // "plain" is not task-capable — the server answers tools/call synchronously;
    // spec: the client MUST be prepared to handle either.
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const handle = await client.callToolTask("plain", {});
    expect(handle.task()?.status).toBe("completed");
    const result = (await handle.result()) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("sync");
    await client.close();
    await server.close();
  });

  it("refuses task calls to servers without the tasks extension", async () => {
    const plain = new MockMCPServer(
      { tools: [{ name: "t", handler: () => ({ content: [] }) }] },
      { era: "legacy" },
    );
    const client = new MCPClient({ servers: { p: { transport: plain.transport } } });
    await client.connect();
    await expect(client.callToolTask("t", {})).rejects.toMatchObject({
      message: expect.stringContaining("tasks extension"),
    });
    await client.close();
    await plain.close();
  });

  it("supports('tasks') reflects the advertised extension", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    expect(client.connections()[0]!.supports("tasks")).toBe(true);
    await client.close();
    await server.close();
  });

  it("CANARY: fails fast on a modern-era connection until the SDK ships the extension runtime", async () => {
    // When this starts failing because the call SUCCEEDS, the SDK gained tasks
    // support — remove assertTasksCallable's era gate (tracking issue #12).
    const server = taskServer("modern");
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();
    expect(client.connections()[0]!.era).toBe("modern");
    await expect(client.callToolTask("crunch", { n: 1 })).rejects.toMatchObject({
      message: expect.stringContaining("2026-07-28"),
    });
    await client.close();
    await server.close();
  });
});

describe("task management", () => {
  it("getTask sees started tasks; listTasks throws (removed by SEP-2663); cancelTask reaches terminal", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } }, taskPollMs: 15 });
    await client.connect();

    const slow = await client.callToolTask("crunch", { n: 1 });
    await expect(client.listTasks("s")).rejects.toMatchObject({
      message: expect.stringContaining("tasks/list was removed"),
    });

    const fetched = await client.getTask(slow.taskId, "s");
    expect(fetched.taskId).toBe(slow.taskId);
    expect(fetched.ttlMs).not.toBeUndefined(); // extension shape: ttlMs, not ttl

    await slow.cancel().catch(() => {}); // may already be completing — either way terminal
    await expect
      .poll(async () => (await client.getTask(slow.taskId, "s")).status, { timeout: 5_000 })
      .toMatch(/cancelled|completed/);
    await client.close();
    await server.close();
  });

  it("getTaskResult (deprecated emulation) polls tasks/get to the inlined result", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } }, taskPollMs: 15 });
    await client.connect();

    const handle = await client.callToolTask("crunch", { n: 9 });
    await handle.result();
    const replay = (await client.getTaskResult(handle.taskId, "s")) as { content: Array<{ text: string }> };
    expect(replay.content[0]?.text).toBe("crunched 9");
    await client.close();
    await server.close();
  });

  it("routes mid-flight input_required through the broker and answers via tasks/update", async () => {
    const server = new MockMCPServer(
      {
        tools: [
          {
            name: "ask_then_finish",
            task: true,
            taskDelayMs: 5,
            handler: async (_args, ctx) => {
              const r = await ctx.elicit({ message: "name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } });
              return { content: [{ type: "text", text: `hi ${(r.content as { name?: string })?.name ?? "?"}` }] };
            },
          },
        ],
      },
      { era: "legacy" },
    );
    const broker = new InteractionBroker({ policy: () => "ask" });
    const client = new MCPClient({
      servers: { s: { transport: server.transport } },
      interactions: broker,
      taskPollMs: 10,
    });
    await client.connect();

    const handle = await client.callToolTask("ask_then_finish", {});
    // The poll loop surfaces the task's inputRequests through the broker queue.
    const resultP = handle.result();
    for (let i = 0; i < 200 && broker.list().length === 0; i++) await tick(5);
    const pending = broker.list()[0];
    expect(pending?.type).toBe("elicitation");
    broker.resolve(pending!.id, { action: "approve", content: { name: "Grace" } });

    const result = (await resultP) as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("hi Grace");
    await client.close();
    await server.close();
  });
});

describe("status pushes (notifications/tasks)", () => {
  it("writes pushed snapshots into the cache for tasks the client never started", async () => {
    const server = taskServer();
    const client = new MCPClient({ servers: { s: { transport: server.transport } } });
    await client.connect();

    const pushed: Task = {
      taskId: "external-1",
      status: "working",
      ttlMs: null,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      statusMessage: "started elsewhere",
    };
    await server.notifyTaskStatus(pushed as unknown as Record<string, unknown>);
    await tick(50);

    const snap = client.cache.getSnapshot({ kind: "task", server: "s", taskId: "external-1" });
    expect((snap?.data as Task | undefined)?.statusMessage).toBe("started elsewhere");
    await client.close();
    await server.close();
  });
});
