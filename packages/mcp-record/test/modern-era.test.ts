// Format-2 cassettes: 2026-07-28 traffic (MRTR rounds, task sequences, skills) records and replays faithfully.
import { describe, it, expect } from "vitest";
import { Client, type Transport } from "@modelcontextprotocol/client";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { sdkSupportsModernTasks } from "../../mcp-query/src/core/tasksProbe.js";
import { TASKS_EXT } from "../../mcp-query/src/core/tasksExt.js";
import { SKILLS_EXT } from "../../mcp-query/src/testing/mockSkills.js";
import { CASSETTE_VERSION, cassetteHash, createCassette, loadCassette, sealCassette, upgradeCassette, type Cassette } from "../src/cassette.js";
import { recordTransport, redactPaths } from "../src/record.js";
import { replayTransport } from "../src/replay.js";

const PASS = { "~standard": { version: 1, vendor: "test", validate: (value: unknown) => ({ value }) } };
const raw = (c: Client, method: string, params: Record<string, unknown>) =>
  (c as unknown as { request(r: unknown, s: unknown, o?: unknown): Promise<Record<string, unknown>> }).request({ method, params }, PASS, { timeout: 5000 });
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

// SDK 2.0.0 era-gates `tasks/*` on its client, so task traffic is driven as raw 2026-07-28 JSON-RPC.
async function rawSession(t: Transport, caps: Record<string, unknown>) {
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  t.onmessage = (m) => {
    const r = m as unknown as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (r.id !== undefined) waiting.get(r.id)?.(r as never);
  };
  await t.start();
  let id = 0;
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": caps };
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (m) => ((m as { error?: { message: string } }).error ? reject(new Error((m as { error: { message: string } }).error.message)) : resolve((m as { result: Record<string, unknown> }).result)));
      void t.send({ jsonrpc: "2.0", id: n, method, params: { ...params, _meta: meta } } as never);
    });
  await call("server/discover");
  return { call, close: () => t.close() };
}

function modernClient(caps: Record<string, unknown> = {}) {
  const c = new Client({ name: "t", version: "1" }, { capabilities: caps, versionNegotiation: { mode: "auto" } } as never);
  return c;
}
const withExt = (id: string) => ({ extensions: { [id]: {} } });

describe("format 2 cassettes", () => {
  it("records the modern header (server/discover) and tags MRTR rounds; replays both rounds faithfully", async () => {
    const answers: string[] = [];
    const mock = new MockMCPServer(
      { tools: [{ name: "ask", handler: async (_a, ctx) => { const r = await ctx.elicit({ message: "name?", requestedSchema: { type: "object", properties: { n: { type: "string" } } } }); return { content: [{ type: "text", text: JSON.stringify(r.content) }] }; } }] },
      { era: "modern" },
    );
    const cassette = createCassette();
    const rec = modernClient({ elicitation: { form: {} } });
    rec.setRequestHandler("elicitation/create", async () => { answers.push("a"); return { action: "accept", content: { n: "ada" } } as never; });
    await rec.connect(recordTransport(mock.transport(), cassette));
    expect(rec.getProtocolEra()).toBe("modern");
    expect(text(await rec.callTool({ name: "ask", arguments: {} }))).toBe('{"n":"ada"}');
    await rec.close();

    expect(cassette.version).toBe(CASSETTE_VERSION);
    expect(cassette.protocol).toMatchObject({ era: "modern", supportedVersions: ["2026-07-28"] });
    expect(cassette.capabilities?.tools).toBeTruthy();
    expect(cassette.recordedFrom?.name).toBe("mock");
    expect(cassette.interactions.some((i) => i.method === "server/discover")).toBe(false);
    const calls = cassette.interactions.filter((i) => i.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ kind: "mrtr", mrtr: { round: 0, inputRequired: true } });
    expect((calls[0]!.result as { resultType: string }).resultType).toBe("input_required");
    expect(calls[1]).toMatchObject({ kind: "mrtr", mrtr: { round: 1, inputRequired: false } });
    expect((calls[1]!.params as { requestState?: string }).requestState).toBe((calls[0]!.result as { requestState: string }).requestState);

    // replay: the client still answers the elicitation; the mock is never touched.
    const connects = mock.connectCount;
    const rp = modernClient({ elicitation: { form: {} } });
    rp.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { n: "ada" } }) as never);
    await rp.connect(replayTransport(JSON.parse(JSON.stringify(cassette)))());
    expect(rp.getProtocolEra()).toBe("modern");
    expect(text(await rp.callTool({ name: "ask", arguments: {} }))).toBe('{"n":"ada"}');
    await rp.close();
    expect(mock.connectCount).toBe(connects);

    // Strict by default: other answers do not match the recorded retry...
    const other = modernClient({ elicitation: { form: {} } });
    other.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { n: "grace" } }) as never);
    await other.connect(replayTransport(cassette)());
    await expect(other.callTool({ name: "ask", arguments: {} })).rejects.toThrow(/no recorded interaction matches/);
    await other.close();
    // ...and match only under the explicit looseInputResponses opt-in.
    const loose = modernClient({ elicitation: { form: {} } });
    loose.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { n: "grace" } }) as never);
    await loose.connect(replayTransport(cassette, { looseInputResponses: true })());
    expect(text(await loose.callTool({ name: "ask", arguments: {} }))).toBe('{"n":"ada"}');
    await loose.close();
    mock.close();
  });

  // Task traffic. Legacy-era tasks work on every SDK; on a 2026-07-28 connection SDK 2.0.0 gates
  // `tasks/*` off the wire on both client and server (>= 2.3.0 lets them through), so that variant
  // runs only where the installed SDK allows it.
  async function taskSequence(era: "legacy" | "modern") {
    const mock = new MockMCPServer({ tools: [{ name: "slow", task: true, taskDelayMs: 60, handler: () => ({ content: [{ type: "text", text: "done" }] }) }, { name: "forever", task: true, taskDelayMs: 60_000, handler: () => ({ content: [] }) }] }, { era });
    const cassette = createCassette();
    const caps = withExt(TASKS_EXT);
    const open = async (transport: Transport) => {
      if (era === "modern") return rawSession(transport, caps);
      const c = new Client({ name: "t", version: "1" }, { capabilities: caps } as never);
      await c.connect(transport);
      return { call: (m: string, p: Record<string, unknown> = {}) => raw(c, m, { ...p, _meta: { "io.modelcontextprotocol/clientCapabilities": caps } }), close: () => c.close() };
    };
    const rec = await open(recordTransport(mock.transport(), cassette));
    const created = await rec.call("tools/call", { name: "slow", arguments: {} });
    const taskId = created.taskId as string;
    const statuses: string[] = [];
    for (let i = 0; i < 60; i++) {
      const t = await rec.call("tasks/get", { taskId });
      statuses.push(t.status as string);
      if (t.status === "completed") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(statuses.at(-1)).toBe("completed");
    const foreverId = (await rec.call("tools/call", { name: "forever", arguments: {} })).taskId as string;
    await rec.call("tasks/cancel", { taskId: foreverId });
    expect((await rec.call("tasks/get", { taskId: foreverId })).status).toBe("cancelled");
    await rec.close();

    expect(cassette.protocol?.era).toBe(era);
    const kinds = cassette.interactions.map((i) => `${i.method}:${i.kind ?? "-"}`);
    expect(kinds).toContain("tools/call:task"); // the call that created the task
    expect(kinds.filter((k) => k === "tasks/get:task").length).toBe(statuses.length + 1);
    expect(kinds).toContain("tasks/cancel:task");

    const rp = await open(replayTransport(cassette)());
    expect((await rp.call("tools/call", { name: "slow", arguments: {} })).taskId).toBe(taskId);
    const replayed: string[] = [];
    for (let i = 0; i < statuses.length; i++) replayed.push((await rp.call("tasks/get", { taskId })).status as string);
    expect(replayed).toEqual(statuses); // same polling sequence, in order
    expect((await rp.call("tasks/get", { taskId })).status).toBe("completed"); // terminal status sticks
    expect((await rp.call("tools/call", { name: "forever", arguments: {} })).taskId).toBe(foreverId);
    await rp.call("tasks/cancel", { taskId: foreverId });
    expect((await rp.call("tasks/get", { taskId: foreverId })).status).toBe("cancelled");
    await rp.close();
    mock.close();
  }

  it("records a task sequence (create, tasks/get polling, tasks/cancel) and replays the statuses in order (legacy era)", () => taskSequence("legacy"));

  it("does the same on a 2026-07-28 connection where the SDK allows tasks", async () => {
    const probe = new Client({ name: "t", version: "1" }, { capabilities: {}, versionNegotiation: { mode: "auto" } } as never);
    const m = new MockMCPServer({ tools: [{ name: "x" }] }, { era: "modern" });
    await probe.connect(m.transport());
    const allowed = await sdkSupportsModernTasks(probe as never);
    await probe.close();
    m.close();
    if (!allowed) return; // SDK 2.0.0 era-gates tasks/* off the modern wire (see mcp-query/test/tasks.test.ts)
    await taskSequence("modern");
  });

  it("records and replays skills/* calls and the skill file read", async () => {
    const mock = new MockMCPServer({ skills: [{ name: "pdf-tools", description: "Work with PDFs", body: "# PDF" }] }, { era: "modern" });
    const cassette = createCassette();
    const rec = modernClient(withExt(SKILLS_EXT));
    await rec.connect(recordTransport(mock.transport(), cassette));
    const list = await raw(rec, "skills/list", {});
    const uri = (list.skills as Array<{ uri: string }>)[0]!.uri;
    const got = await raw(rec, "skills/get", { uri });
    const file = await rec.readResource({ uri });
    await rec.close();
    expect(cassette.interactions.filter((i) => i.kind === "skill").map((i) => i.method)).toEqual(["skills/list", "skills/get"]);

    const rp = modernClient(withExt(SKILLS_EXT));
    await rp.connect(replayTransport(cassette)());
    expect(await raw(rp, "skills/list", {})).toEqual(list);
    expect(await raw(rp, "skills/get", { uri })).toEqual(got);
    expect(await rp.readResource({ uri })).toEqual(file);
    await rp.close();
    mock.close();
  });

  it("redaction leaves the MRTR/task tags intact and the integrity hash covers the header", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.msg) }] }) }] }, { era: "modern" });
    const cassette = createCassette();
    const rec = modernClient();
    await rec.connect(recordTransport(mock.transport(), cassette, { redact: redactPaths(["params.arguments.msg"]) }));
    await rec.callTool({ name: "echo", arguments: { msg: "secret" } });
    await rec.close();
    expect(cassette.interactions[0]!.params).toMatchObject({ arguments: { msg: "[REDACTED]" } });
    sealCassette(cassette);
    const tampered: Cassette = JSON.parse(JSON.stringify(cassette));
    tampered.capabilities = { tools: {}, resources: {} };
    expect(cassetteHash(tampered)).not.toBe(cassette.integrity);
    expect(() => loadCassette(JSON.stringify(tampered))).toThrow(/integrity/);
    expect(loadCassette(JSON.stringify(cassette)).version).toBe(2);
    mock.close();
  });
});

describe("cassette format versions", () => {
  const v1 = {
    version: 1,
    recordedFrom: { name: "old", version: "1" },
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    interactions: [
      { method: "tools/list", result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
      { method: "tools/call", params: { name: "echo", arguments: {} }, result: { resultType: "input_required", requestState: "s1", inputRequests: {} } },
      { method: "tools/call", params: { name: "echo", arguments: {}, requestState: "s1", inputResponses: { q: { action: "accept" } } }, result: { content: [{ type: "text", text: "ok" }] } },
      { method: "tasks/get", params: { taskId: "t1" }, result: { status: "working" } },
    ],
  };

  it("reads a format-1 cassette (versioned or not) and tags it on upgrade", () => {
    for (const input of [v1, { ...v1, version: undefined }]) {
      const c = loadCassette(JSON.stringify(input));
      expect(c.version).toBe(2);
      expect(c.interactions.map((i) => i.kind)).toEqual([undefined, "mrtr", "mrtr", "task"]);
      expect(c.interactions[2]!.mrtr).toEqual({ round: 1, inputRequired: false });
    }
  });

  it("verifies a sealed format-1 cassette against its original hash, then re-seals it in the new format", () => {
    const sealed = { ...v1, integrity: cassetteHash(v1 as never) };
    const c = loadCassette(JSON.stringify(sealed));
    expect(c.integrity).toBe(cassetteHash(c));
    const bad = JSON.parse(JSON.stringify(sealed));
    bad.interactions[0].result.tools[0].name = "evil";
    expect(() => loadCassette(JSON.stringify(bad))).toThrow(/integrity/);
  });

  it("refuses a format newer than it understands", () => {
    expect(() => loadCassette(JSON.stringify({ ...v1, version: 3 }))).toThrow(/not supported/);
    expect(() => upgradeCassette({ ...v1, version: "x" } as never)).toThrow(/not supported/);
  });

  it("replays a format-1 cassette (legacy handshake) unchanged", async () => {
    const mock = new MockMCPServer({ tools: [{ name: "echo", handler: () => ({ content: [{ type: "text", text: "hi" }] }) }] }, { era: "legacy" });
    const cassette = createCassette();
    const rec = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rec.connect(recordTransport(mock.transport(), cassette));
    await rec.callTool({ name: "echo", arguments: {} });
    await rec.close();
    expect(cassette.protocol).toMatchObject({ era: "legacy" });
    const asV1 = JSON.parse(JSON.stringify({ ...cassette, version: 1, protocol: undefined }));
    const rp = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await rp.connect(replayTransport(loadCassette(JSON.stringify(asV1)))());
    expect(text(await rp.callTool({ name: "echo", arguments: {} }))).toBe("hi");
    await rp.close();
    mock.close();
  });
});
