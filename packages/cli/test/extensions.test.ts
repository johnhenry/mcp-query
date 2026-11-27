import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { MockMCPServer, type MockToolContext } from "../../mcp-query/src/testing/mockServer.js";
import { TASKS_EXT } from "../../mcp-query/src/core/tasksExt.js";
import { helpText, parseClient } from "../src/cli.js";
import { opCall, opPrompt } from "../src/invoke.js";
import { InputRequiredError, answerFor, opSkill, opSkills, opTasks, parseAnswers, resolveSkillFile, runRounds } from "../src/extension-verbs.js";

afterEach(() => vi.restoreAllMocks());
function logs(): string[] {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m)));
  vi.spyOn(console, "error").mockImplementation((m?: unknown) => void out.push(`ERR ${String(m)}`));
  return out;
}
async function connect(mock: MockMCPServer, caps: Record<string, unknown> = {}, modern = true): Promise<Client> {
  const c = new Client({ name: "t", version: "1" }, { capabilities: caps, ...(modern ? { versionNegotiation: { mode: "auto" } } : {}) } as never);
  await c.connect(mock.transport());
  return c;
}

const askTool = {
  name: "ask",
  description: "asks a question",
  inputSchema: { type: "object", properties: {} },
  handler: async (_a: Record<string, unknown>, ctx: MockToolContext) => {
    const r = (await ctx.elicit({ message: "who?", requestedSchema: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } }, required: ["name"] } })) as { action: string; content?: Record<string, unknown> };
    return { content: [{ type: "text", text: r.action === "accept" ? `hello ${String(r.content?.name)} ${String(r.content?.age ?? "")}`.trim() : r.action }] };
  },
};

describe("flag parsing", () => {
  it("collects repeatable --answer on call/prompt only; --file only on skill; --era anywhere", () => {
    const p = parseClient(["srv", "ask", "--answer", "name=Ada", "--answer", "age=36", "--era", "auto", "--title", "x"], "call");
    expect(p.flags.answers).toEqual(["name=Ada", "age=36"]);
    expect(p.flags.era).toBe("auto");
    expect(p.rest).toEqual(["srv", "ask", "--title", "x"]); // tool-arg flags pass through untouched
    // on other verbs `--answer` / `--file` stay ordinary tokens (a tool may have an arg of that name)
    expect(parseClient(["srv", "t", "--file", "a.txt"], "call").rest).toEqual(["srv", "t", "--file", "a.txt"]);
    expect(parseClient(["srv", "skill://x/SKILL.md", "--file", "ref/a.md"], "skill").flags.file).toBe("ref/a.md");
    expect(parseClient(["srv", "x", "--answer", "k=v"], "tools").flags.answers).toBeUndefined();
  });

  it("help text documents the new verbs and flags", () => {
    const h = helpText();
    for (const w of ["skills", "skill", "tasks", "--answer", "--file", "--era"]) expect(h).toContain(w);
  });
});

describe("--answer: input_required rounds", () => {
  it("without an answer, reports the pending requests and fails (nothing is guessed)", async () => {
    const out = logs();
    const mock = new MockMCPServer({ tools: [askTool] }, { era: "modern" });
    const c = await connect(mock, { elicitation: { form: {} } });
    const err = await opCall(c, "ask", [], { era: "auto" }).catch((e) => e);
    expect(err).toBeInstanceOf(InputRequiredError);
    expect((err as Error).message).toMatch(/input required/);
    expect((err as Error).message).toContain("elicitation/create");
    expect((err as Error).message).toContain("who?");
    expect((err as Error).message).toContain("name (string)");
    expect((err as InputRequiredError).pending).toHaveProperty("q0");
    expect(out.join("\n")).not.toContain("hello");
    await c.close();
  });

  it("answers a form by field name and by request key, over a real MRTR retry", async () => {
    const out = logs();
    const mock = new MockMCPServer({ tools: [askTool] }, { era: "modern" });
    const c = await connect(mock, { elicitation: { form: {} } });
    await opCall(c, "ask", [], { answers: ["name=Ada", "age=36"] });
    expect(out.join("\n")).toContain("hello Ada 36");
    out.length = 0;
    await opCall(c, "ask", [], { answers: ['q0={"name":"Grace"}'] });
    expect(out.join("\n")).toContain("hello Grace");
    out.length = 0;
    await opCall(c, "ask", [], { answers: ["q0=decline"] });
    expect(out.join("\n")).toContain("decline");
    await c.close();
  });

  it("a partial answer (required field missing) still fails with the pending list", async () => {
    logs();
    const mock = new MockMCPServer({ tools: [askTool] }, { era: "modern" });
    const c = await connect(mock, { elicitation: { form: {} } });
    const err = await opCall(c, "ask", [], { answers: ["age=36"] }).catch((e) => e);
    expect(err).toBeInstanceOf(InputRequiredError);
    expect((err as Error).message).toContain("still need");
    await c.close();
  });

  it("answerFor / parseAnswers edge cases", () => {
    const used = new Set<string>();
    const form = { method: "elicitation/create", params: { requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } } } };
    expect(answerFor("q", form, parseAnswers(["q=true"]), used)).toEqual({ action: "accept", content: { ok: true } }); // single-field form
    expect(answerFor("q", { method: "elicitation/create", params: { mode: "url", url: "https://x" } }, parseAnswers(["q=accept"]), used)).toEqual({ action: "accept" });
    expect(() => answerFor("q", { method: "elicitation/create", params: { requestedSchema: { type: "object", properties: { a: {}, b: {} } } } }, parseAnswers(["q=1"]), used)).toThrow(/2 fields/);
    expect(() => answerFor("q", { method: "sampling/createMessage", params: {} }, parseAnswers(["q=hi"]), used)).toThrow(/JSON object/);
    expect(answerFor("q", { method: "roots/list" }, parseAnswers(['q={"roots":[]}']), used)).toEqual({ roots: [] });
    expect(answerFor("zz", form, parseAnswers([]), used)).toBeUndefined();
    expect(() => parseAnswers(["nokey"])).toThrow(/key=value/);
    expect(parseAnswers(["a=1=2"]).get("a")).toBe("1=2");
  });

  it("gives up after too many rounds and warns about unused answers", async () => {
    const out = logs();
    let n = 0;
    const endless = async () => ({ resultType: "input_required", inputRequests: { q: { method: "elicitation/create", params: { requestedSchema: { type: "object", properties: { a: { type: "string" } } } } } }, requestState: `s${n++}` });
    await expect(runRounds(endless, ["a=1"])).rejects.toThrow(/giving up/);
    await runRounds(async () => ({ resultType: "complete" }), ["x=1"]);
    expect(out.join("\n")).toContain("unused --answer x");
  });

  it("works for prompts/get too", async () => {
    const out = logs();
    const c = { getPrompt: vi.fn(async (p: Record<string, unknown>) => (p.inputResponses ? { messages: [{ role: "user", content: { type: "text", text: "done" } }] } : { resultType: "input_required", inputRequests: { q0: { method: "elicitation/create", params: { requestedSchema: { type: "object", properties: { x: { type: "string" } } } } } }, requestState: "st" })) };
    await opPrompt(c as never, "p", [], { answers: ["x=1"] });
    expect(out.join("\n")).toContain("user: done");
    expect(c.getPrompt.mock.calls[1]![0]).toMatchObject({ requestState: "st", inputResponses: { q0: { action: "accept", content: { x: "1" } } } });
  });
});

describe("skills / skill", () => {
  const mk = () => new MockMCPServer({ skills: [{ name: "pdf-tools", description: "Work with PDFs", body: "# PDF body", files: { "references/GUIDE.md": "guide text" } }, { name: "dyn", description: "dynamic", dynamic: true }, { name: "bad", description: "tampered", tamper: "digest" }] }, { era: "modern" });

  it("lists skills", async () => {
    const out = logs();
    const mock = mk();
    const c = await connect(mock);
    await opSkills(c, {});
    expect(out.join("\n")).toContain("pdf-tools");
    expect(out.join("\n")).toContain("skill://pdf-tools/SKILL.md");
    out.length = 0;
    await opSkills(c, { json: true });
    expect(JSON.parse(out.join("\n"))).toHaveLength(3);
    await c.close();
  });

  it("reads SKILL.md and a --file, verified; refuses unlisted paths, bad digests and traversal", async () => {
    const out = logs();
    const mock = mk();
    const c = await connect(mock);
    await opSkill(c, "skill://pdf-tools/SKILL.md", {});
    expect(out.join("\n")).toContain("# PDF body");
    out.length = 0;
    await opSkill(c, "skill://pdf-tools/SKILL.md", { file: "references/GUIDE.md" });
    expect(out.join("\n")).toBe("guide text");
    await expect(opSkill(c, "skill://pdf-tools/SKILL.md", { file: "nope.md" })).rejects.toThrow();
    await expect(opSkill(c, "skill://pdf-tools/SKILL.md", { file: "../x" })).rejects.toThrow(/inside the skill/);
    await expect(opSkill(c, "skill://bad/SKILL.md", {})).rejects.toThrow(/digest/);
    out.length = 0;
    await opSkill(c, "skill://dyn/SKILL.md", {});
    expect(out.join("\n")).toContain("NOT verified");
    await expect(opSkill(c, "skill://missing/SKILL.md", {})).rejects.toThrow();
    await c.close();
  });

  it("resolveSkillFile", () => {
    expect(resolveSkillFile("skill://a/SKILL.md", undefined)).toBe("skill://a/SKILL.md");
    expect(resolveSkillFile("skill://a/SKILL.md", "x/./y.md")).toBe("skill://a/x/y.md");
    expect(resolveSkillFile("skill://a/SKILL.md", "skill://a/z.md")).toBe("skill://a/z.md");
    expect(() => resolveSkillFile("skill://a/SKILL.md", "/etc/passwd")).toThrow();
  });
});

describe("tasks get / cancel", () => {
  it("gets a task and cancels one (legacy-era connection: every SDK allows tasks there)", async () => {
    const out = logs();
    const mock = new MockMCPServer({ tools: [{ name: "slow", task: true, taskDelayMs: 60_000, handler: () => ({ content: [] }) }] }, { era: "legacy" });
    const c = await connect(mock, {}, false);
    const created = (await (c as unknown as { request(r: unknown, s: unknown): Promise<Record<string, unknown>> }).request(
      { method: "tools/call", params: { name: "slow", arguments: {}, _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXT]: {} } } } } },
      { "~standard": { version: 1, vendor: "t", validate: (value: unknown) => ({ value }) } },
    )) as { taskId: string };
    await opTasks(c, "get", created.taskId, {});
    expect(out.join("\n")).toContain(created.taskId);
    expect(out.join("\n")).toContain("working");
    out.length = 0;
    await opTasks(c, "cancel", created.taskId, {});
    await opTasks(c, "get", created.taskId, { json: true });
    expect(JSON.parse(out.join("\n").slice(out.join("\n").lastIndexOf("{\n")))).toMatchObject({ status: "cancelled" });
    await expect(opTasks(c, "get", "nope", {})).rejects.toThrow();
    await expect(opTasks(c, "list", "x", {})).rejects.toThrow(/usage/);
    await c.close();
    mock.close();
  });
});
