import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";

import { registryVerbs } from "../src/registry-verbs.js";
import { formatResult, toolSignature } from "../src/format.js";
import { parseCallExpr, parseCallArgs } from "../src/invoke.js";
import { helpText, run } from "../src/cli.js";

// Coercion mirrors invoke.ts (kept local so the test doesn't reach into private helpers):
// the public surface we assert against is parseCallArgs (parsing) + formatResult (rendering)
// + an actual MockMCPServer round-trip for the call path.

const everythingMock = (): MockMCPServer =>
  new MockMCPServer({
    tools: [
      {
        name: "add",
        description: "Add two numbers and return the sum",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        handler: (args) => ({ content: [{ type: "text", text: String((args.a as number) + (args.b as number)) }] }),
      },
      {
        name: "echo",
        description: "Echo a message",
        inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
        handler: (args) => ({ content: [{ type: "text", text: String(args.message) }] }),
      },
    ],
  });

afterEach(() => vi.restoreAllMocks());

describe("(a) registry-verbs table", () => {
  it("exposes all 8 tool verbs, each with describe + a lazy load()", () => {
    const expected = ["codegen", "inspect", "contract", "lint", "docs", "bench", "record", "gate"];
    expect(Object.keys(registryVerbs).sort()).toEqual([...expected].sort());
    for (const [name, verb] of Object.entries(registryVerbs)) {
      expect(typeof verb.describe, name).toBe("string");
      expect(verb.describe.length, name).toBeGreaterThan(0);
      expect(typeof verb.load, name).toBe("function");
    }
  });
});

describe("(b) grouped help", () => {
  it("helpText() lists Tools / Registry / Client sections + every verb", () => {
    const help = helpText();
    expect(help).toMatch(/^Tools$/m);
    expect(help).toMatch(/^Registry$/m);
    expect(help).toMatch(/^Client$/m);
    // a verb from each family
    expect(help).toContain("lint");
    expect(help).toContain("servers");
    expect(help).toContain("call");
    expect(help).toContain("ping");
  });

  it("run([]) prints the grouped help without exiting", async () => {
    const out: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m)));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    await run([]);
    expect(exitSpy).not.toHaveBeenCalled();
    const text = out.join("\n");
    expect(text).toMatch(/^Tools$/m);
    expect(text).toMatch(/^Registry$/m);
    expect(text).toMatch(/^Client$/m);
    logSpy.mockRestore();
  });
});

describe("(c) call/tools arg coercion + formatResult against a MockMCPServer", () => {
  it("tools() listing renders signatures; --json mode renders compact name/desc", async () => {
    const mock = everythingMock();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(mock.transport());
    const { tools } = await client.listTools();

    const sig = toolSignature(tools.find((t) => t.name === "add")! as never);
    expect(sig).toContain("add(a: number, b: number)");
    expect(sig).toContain("Add two numbers");

    const json = formatResult(tools.map((t) => ({ name: t.name, description: t.description })), "json");
    expect(JSON.parse(json)).toEqual([
      { name: "add", description: "Add two numbers and return the sum" },
      { name: "echo", description: "Echo a message" },
    ]);
    await client.close();
  });

  it("coerces flag-style args by inputSchema and the call returns the expected content", async () => {
    const mock = everythingMock();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(mock.transport());
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "add")!.inputSchema;

    // Simulate the CLI: parse `add --a 2 --b 3`, then coerce by schema (string "2" → number 2).
    const parsed = parseCallArgs("add", ["--a", "2", "--b", "3"]);
    expect(parsed.tool).toBe("add");
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.args)) {
      const t = (schema.properties as Record<string, { type?: string }>)[k]?.type;
      args[k] = t === "number" && typeof v === "string" ? Number(v) : v;
    }
    expect(args).toEqual({ a: 2, b: 3 });

    const result = await client.callTool({ name: "add", arguments: args });
    expect(formatResult(result.content, "human")).toBe("5");
    expect(JSON.parse(formatResult(result.content, "json"))).toEqual([{ type: "text", text: "5" }]);
    await client.close();
  });

  it("formatResult renders an aligned table for arrays of flat objects", () => {
    const table = formatResult(
      [
        { name: "linear", kind: "http" },
        { name: "everything", kind: "stdio" },
      ],
      "human",
    );
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/name\s+kind/);
    expect(lines[1]).toMatch(/^-+\s+-+$/);
    expect(table).toContain("linear");
    expect(table).toContain("everything");
  });
});

describe("(d) function-call arg parser", () => {
  it("parseCallExpr parses name + typed literals", () => {
    const r = parseCallExpr('create_issue(title: "Bug", team: "ENG", count: 3, urgent: true, tags: ["a","b"])');
    expect(r).toBeDefined();
    expect(r!.name).toBe("create_issue");
    expect(r!.args).toEqual({ title: "Bug", team: "ENG", count: 3, urgent: true, tags: ["a", "b"] });
  });

  it("parseCallExpr handles an empty arg list and commas inside strings", () => {
    expect(parseCallExpr("noop()")).toEqual({ name: "noop", args: {} });
    const r = parseCallExpr('say(text: "hello, world", n: 2)');
    expect(r!.args).toEqual({ text: "hello, world", n: 2 });
  });

  it("returns undefined for a non-call expression", () => {
    expect(parseCallExpr("not a call")).toBeUndefined();
  });

  it("parseCallArgs accepts a single function-call token and infers the tool name", () => {
    const r = parseCallArgs(undefined, ['create_issue(title: "Bug", team: "ENG")']);
    expect(r.tool).toBe("create_issue");
    expect(r.args).toEqual({ title: "Bug", team: "ENG" });
  });

  it("parseCallArgs accepts mixed flag and key=value tokens", () => {
    const r = parseCallArgs("create_issue", ["--title", "Bug", "team=ENG", "--draft"]);
    expect(r.tool).toBe("create_issue");
    expect(r.args).toEqual({ title: "Bug", team: "ENG", draft: true });
  });
});
