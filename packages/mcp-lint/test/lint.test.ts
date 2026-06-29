import { describe, it, expect } from "vitest";
import type { Contract } from "../../mcp-contract/src/contract.js";
import { lintContract } from "../src/lint.js";

const base: Contract = { version: 1, tools: [], resources: [], templates: [], prompts: [] };
const find = (c: Contract, rule: string, opts = {}) => lintContract(c, opts).findings.filter((f) => f.rule === rule);

describe("mcp-lint rules", () => {
  it("flags a tool with no description as an error", () => {
    const c = { ...base, tools: [{ name: "echo", description: "" }] };
    const f = find(c, "tool-description");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
  });

  it("warns on undocumented input properties", () => {
    const c: Contract = {
      ...base,
      tools: [{ name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number", description: "addend" } } } }],
    };
    const f = find(c, "tool-input-described");
    expect(f.map((x) => x.message)).toEqual(['input "a" has no description']); // b is documented
  });

  it("warns when a destructive-named tool lacks destructiveHint, and a read-named tool lacks readOnlyHint", () => {
    const c: Contract = {
      ...base,
      tools: [
        { name: "delete-file", description: "d" },
        { name: "get-file", description: "g" },
        { name: "remove_item", description: "r", annotations: { destructiveHint: true } }, // properly annotated → no finding
      ],
    };
    expect(find(c, "destructive-annotation").map((x) => x.target)).toEqual(["delete-file"]);
    expect(find(c, "read-only-annotation").map((x) => x.target)).toEqual(["get-file"]);
  });

  it("warns on untyped inputs, missing resource mimeType, and undescribed prompts", () => {
    const c: Contract = {
      ...base,
      tools: [{ name: "freeform", description: "f", inputSchema: { type: "object", additionalProperties: true } }],
      resources: [{ uri: "file:///a" }],
      prompts: [{ name: "p" }],
    };
    expect(find(c, "no-open-input")).toHaveLength(1);
    expect(find(c, "resource-mime-type")).toHaveLength(1);
    expect(find(c, "prompt-description")).toHaveLength(1);
  });

  it("warns once when tool names mix conventions", () => {
    const c: Contract = { ...base, tools: [{ name: "get-thing", description: "a" }, { name: "get_other", description: "b" }] };
    const f = find(c, "naming-consistency");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("kebab-case");
    expect(f[0]!.message).toContain("snake_case");
  });

  it("respects severity overrides (off)", () => {
    const c: Contract = { ...base, tools: [{ name: "get-x", description: "a" }, { name: "get_y", description: "b" }] };
    expect(find(c, "naming-consistency")).toHaveLength(1);
    expect(find(c, "naming-consistency", { rules: { "naming-consistency": "off" } })).toHaveLength(0);
  });

  it("a clean surface yields no findings", () => {
    const c: Contract = {
      ...base,
      tools: [{ name: "get-user", description: "Fetch a user", inputSchema: { type: "object", properties: { id: { type: "string", description: "user id" } }, required: ["id"] }, annotations: { readOnlyHint: true } }],
      resources: [{ uri: "file:///a", mimeType: "text/plain" }],
      prompts: [{ name: "greet", description: "Say hi" }],
    };
    expect(lintContract(c).findings).toEqual([]);
  });
});
