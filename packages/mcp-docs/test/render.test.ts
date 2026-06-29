import { describe, it, expect } from "vitest";
import type { Contract } from "../../mcp-contract/src/contract.js";
import { renderMarkdown, schemaType } from "../src/render.js";

describe("schemaType", () => {
  it("renders scalars, arrays, and enums", () => {
    expect(schemaType({ type: "string" })).toBe("string");
    expect(schemaType({ type: "array", items: { type: "number" } })).toBe("number[]");
    expect(schemaType({ enum: ["a", "b"] })).toBe('"a" \\| "b"');
    expect(schemaType(undefined)).toBe("any");
  });
});

describe("renderMarkdown", () => {
  const contract: Contract = {
    version: 1,
    server: { name: "demo", version: "1.2.0" },
    tools: [
      {
        name: "get-user",
        description: "Fetch a user by id.",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "the user id" } }, required: ["id"] },
        annotations: { readOnlyHint: true },
      },
      { name: "ping", description: "No-arg health check." },
    ],
    resources: [{ uri: "file:///readme", name: "Readme", mimeType: "text/markdown" }],
    templates: [{ uriTemplate: "file:///users/{id}", name: "user" }],
    prompts: [{ name: "greet", description: "Greeting prompt", arguments: [{ name: "name", required: true }] }],
  };

  const md = renderMarkdown(contract);

  it("titles from server identity and shows counts", () => {
    expect(md).toContain("# demo v1.2.0");
    expect(md).toContain("> 2 tools · 1 resources · 1 templates · 1 prompts");
  });

  it("renders tool sections with badges and an args table", () => {
    expect(md).toContain("### `get-user` — `read-only`");
    expect(md).toContain("| `id` | string | ✔ | the user id |");
    expect(md).toContain("### `ping`");
    expect(md).toContain("_No arguments._"); // ping takes none
  });

  it("renders resources, templates, and prompts", () => {
    expect(md).toContain("| `file:///readme` | Readme | text/markdown |");
    expect(md).toContain("| `file:///users/{id}` | user |");
    expect(md).toContain("### `greet`");
    expect(md).toContain("| `name` | ✔ |");
  });

  it("supports a custom title", () => {
    expect(renderMarkdown(contract, { title: "My API" })).toContain("# My API");
  });
});
