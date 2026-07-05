import { describe, it, expect } from "vitest";
import { parseCallSpec, parseCallExpr, looksLikeCallExpr } from "../src/callspec.js";
import { rejectUnknownFlags } from "../src/flags.js";

describe("parseCallSpec — unified --call syntax", () => {
  it("parses the colon+JSON form", () => {
    expect(parseCallSpec('get-sum:{"a":1,"b":2}')).toEqual({ name: "get-sum", args: { a: 1, b: 2 } });
  });

  it("parses the function-call form with typed literals", () => {
    expect(parseCallSpec('echo(message: "hi", n: 2, ok: true)')).toEqual({
      name: "echo",
      args: { message: "hi", n: 2, ok: true },
    });
  });

  it("both forms of the same call parse identically", () => {
    expect(parseCallSpec('echo(message: "hi")')).toEqual(parseCallSpec('echo:{"message":"hi"}'));
  });

  it("a bare tool name means no arguments", () => {
    expect(parseCallSpec("noop")).toEqual({ name: "noop", args: {} });
    expect(parseCallSpec("noop()")).toEqual({ name: "noop", args: {} });
  });

  it("rejects malformed specs with an error naming BOTH accepted forms", () => {
    for (const bad of ['echo:{"message"', "echo(message", "not a spec at all", 'echo:"just-a-string"']) {
      expect(() => parseCallSpec(bad)).toThrow(/tool:\{"arg":"value"\}.*tool\(arg: "value"/s);
    }
  });

  it("looksLikeCallExpr / parseCallExpr still behave as before the move from packages/cli", () => {
    expect(looksLikeCallExpr('create_issue(title: "Bug")')).toBe(true);
    expect(looksLikeCallExpr("everything")).toBe(false);
    const r = parseCallExpr('create_issue(title: "Bug, fix", tags: ["a","b"])');
    expect(r).toEqual({ name: "create_issue", args: { title: "Bug, fix", tags: ["a", "b"] } });
    expect(parseCallExpr("not a call")).toBeUndefined();
  });
});

describe("rejectUnknownFlags", () => {
  it("passes when every flag is known", () => {
    expect(() => rejectUnknownFlags("mcp-x", { url: "u", out: "f" }, ["url", "out"])).not.toThrow();
  });

  it("throws naming the flag, the tool, and the known list", () => {
    expect(() => rejectUnknownFlags("mcp-bench", { urll: "typo" }, ["url", "command"])).toThrow(
      /unknown flag --urll for mcp-bench \(known: --url, --command\)/,
    );
  });

  it("pluralizes for multiple unknown flags", () => {
    expect(() => rejectUnknownFlags("mcp-x", { a: 1, b: 2 }, ["c"])).toThrow(/unknown flags --a, --b for mcp-x/);
  });
});
