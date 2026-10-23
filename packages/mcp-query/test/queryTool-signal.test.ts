// queryTool({ signal }): per-caller cancellation of the wait, ref-counted so a shared
// in-flight request is only cancelled upstream when every caller has aborted.
import { describe, expect, it } from "vitest";
import { MCPClient } from "../src/core/client.js";
import { argsHash } from "../src/core/keys.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const state = { started: 0, cancelled: 0, release: () => {} };
  const gate = new Promise<void>((r) => (state.release = r));
  const mock = new MockMCPServer({
    tools: [
      {
        name: "slow",
        annotations: { readOnlyHint: true },
        handler: async (_a, ctx) => {
          state.started++;
          ctx.signal?.addEventListener("abort", () => state.cancelled++);
          await Promise.race([gate, new Promise((r) => ctx.signal?.addEventListener("abort", r))]);
          return { content: [{ type: "text", text: "done" }] };
        },
      },
    ],
  });
  const client = new MCPClient({ servers: { s: { transport: mock.transport } } });
  return { state, client };
}

// Settle eagerly so a rejection that lands before the test awaits is never "unhandled".
const abortErr = (p: Promise<unknown>): Promise<Error> => p.then(() => new Error("resolved"), (e: Error) => e);

describe("queryTool signal", () => {
  it("aborting one of two shared callers rejects only it; the request is not cancelled", async () => {
    const { state, client } = setup();
    await client.connect();
    const a = new AbortController();
    const pa = abortErr(client.queryTool("s.slow", { q: 1 }, { signal: a.signal }));
    const pb = client.queryTool("s.slow", { q: 1 });
    await tick(50);
    a.abort();
    const err = await pa;
    expect(err.name).toBe("AbortError");
    await tick(50);
    expect(state.cancelled).toBe(0);
    state.release();
    const res = (await pb) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("done");
    expect(state.started).toBe(1);
    expect(state.cancelled).toBe(0);
    await client.close();
  });

  it("aborting every waiting caller cancels the request on the server", async () => {
    const { state, client } = setup();
    await client.connect();
    const a = new AbortController();
    const b = new AbortController();
    const pa = abortErr(client.queryTool("s.slow", {}, { signal: a.signal }));
    const pb = abortErr(client.queryTool("s.slow", {}, { signal: b.signal }));
    await tick(50);
    a.abort();
    await tick(50);
    expect(state.cancelled).toBe(0);
    b.abort();
    expect((await pa).name).toBe("AbortError");
    expect((await pb).name).toBe("AbortError");
    await tick(100);
    expect(state.cancelled).toBe(1);
    await client.close();
  });

  it("an already-aborted signal rejects immediately without starting a request", async () => {
    const { state, client } = setup();
    await client.connect();
    const ac = new AbortController();
    ac.abort();
    expect((await abortErr(client.queryTool("s.slow", {}, { signal: ac.signal }))).name).toBe("AbortError");
    await tick(30);
    expect(state.started).toBe(0);
    await client.close();
  });

  it("an aborted sole caller does not poison the cache; a later call succeeds", async () => {
    const { state, client } = setup();
    await client.connect();
    const ac = new AbortController();
    const p = abortErr(client.queryTool("s.slow", {}, { signal: ac.signal }));
    await tick(50);
    ac.abort();
    await p;
    await tick(100);
    const key = { kind: "toolResult", server: "s", tool: "slow", argsHash: argsHash({}) } as const;
    expect(client.cache.getSnapshot(key)?.status).not.toBe("error");
    expect(client.cache.getSnapshot(key)?.error).toBeUndefined();
    state.release();
    const res = (await client.queryTool("s.slow", {})) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("done");
    expect(client.cache.getSnapshot(key)?.status).toBe("success");
    await client.close();
  });

  it("a signal that never fires leaves the result and cache untouched", async () => {
    const { state, client } = setup();
    await client.connect();
    state.release();
    const ac = new AbortController();
    const res = (await client.queryTool("s.slow", {}, { signal: ac.signal })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toBe("done");
    ac.abort(); // after settle: no effect
    const key = { kind: "toolResult", server: "s", tool: "slow", argsHash: argsHash({}) } as const;
    expect(client.cache.getSnapshot(key)?.status).toBe("success");
    await client.close();
  });
});
