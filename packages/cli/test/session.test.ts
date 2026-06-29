import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer } from "../../mcp-query/src/testing/mockServer.js";
import { tokenize, dispatch } from "../src/session.js";

describe("session tokenizer", () => {
  it("splits on whitespace respecting quotes", () => {
    expect(tokenize('call echo --message "hello world"')).toEqual(["call", "echo", "--message", "hello world"]);
    expect(tokenize("a 'b c' d")).toEqual(["a", "b c", "d"]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize('--message ""')).toEqual(["--message", ""]); // explicit empty arg
  });
});

describe("session dispatch (against a live mock client)", () => {
  let client: Client;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const mock = new MockMCPServer({
      tools: [
        { name: "echo", handler: (a) => ({ content: [{ type: "text", text: String(a.message) }] }) },
        { name: "add", handler: (a) => ({ content: [{ type: "text", text: String(Number(a.a) + Number(a.b)) }] }) },
      ],
    });
    client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(mock.transport());
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((s: string) => void logs.push(String(s)));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    await client.close();
  });

  it("exit/quit signal exit; help prints", async () => {
    expect(await dispatch(client, "exit", {})).toBe("exit");
    expect(await dispatch(client, "quit", {})).toBe("exit");
    await dispatch(client, "help", {});
    expect(logs.join("\n")).toContain("commands:");
  });

  it("`tools` lists the mock's tools", async () => {
    await dispatch(client, "tools", {});
    expect(logs.join("\n")).toMatch(/echo/);
    expect(logs.join("\n")).toMatch(/add/);
  });

  it("`call echo --message hi` flag-style", async () => {
    await dispatch(client, "call echo --message hi", {});
    expect(logs.join("\n")).toContain("hi");
  });

  it("bareword shorthand `add a=2 b=3`", async () => {
    await dispatch(client, "add a=2 b=3", {});
    expect(logs.join("\n")).toContain("5");
  });

  it("function-call form `add(a: 2, b: 40)`", async () => {
    await dispatch(client, "add(a: 2, b: 40)", {});
    expect(logs.join("\n")).toContain("42");
  });

  it("`json` toggles output mode (subsequent call emits JSON)", async () => {
    const f = {};
    await dispatch(client, "json", f);
    expect(f).toMatchObject({ json: true });
    await dispatch(client, "call echo --message hi", f);
    expect(logs.some((l) => l.trim().startsWith("["))).toBe(true); // JSON content array
  });
});
