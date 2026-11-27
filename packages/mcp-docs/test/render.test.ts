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
    version: 2,
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

describe("renderMarkdown (contract v2)", () => {
  const v2: Contract = {
    version: 2,
    server: { name: "demo", version: "2.0.0" },
    protocol: { era: "modern", negotiated: "2026-07-28", supported: ["2025-11-25", "2026-07-28"] },
    capabilities: { tools: { listChanged: true }, logging: {} },
    extensions: { "io.modelcontextprotocol/tasks": { revision: "2026-09-01" }, "io.example/plain": {}, "io.example/rich": { revision: "3", mode: "a|b" } },
    tools: [{ name: "get-user", title: "Get a user", description: "Fetch.", annotations: { readOnlyHint: true } }],
    resources: [],
    templates: [],
    prompts: [],
    skills: [{ uri: "skill://review/SKILL.md", name: "review", description: "Review code", files: [{ uri: "skill://review/SKILL.md", digest: "sha256:aa", size: 3 }] }],
    events: [
      {
        name: "pr.opened",
        description: "A PR was opened.",
        inputSchema: { type: "object", properties: { repo: { type: "string", description: "owner/name" } }, required: ["repo"] },
        payloadSchema: { type: "object" },
        delivery: ["poll", "push"],
      },
    ],
  };
  const md = renderMarkdown(v2);

  it("renders the protocol line and an extensions table with revisions", () => {
    expect(md).toContain("**Protocol:** modern era · negotiated `2026-07-28` · supports `2025-11-25`, `2026-07-28`");
    expect(md).toContain("## Extensions");
    expect(md).toContain("| `io.modelcontextprotocol/tasks` | `2026-09-01` |  |");
    expect(md).toContain("| `io.example/plain` |  |  |");
    expect(md).toContain('| `io.example/rich` | `3` | `{"mode":"a\\|b"}` |'); // pipes escaped so the table survives
  });

  it("badges deprecated capabilities with their SEP and removal window, and leaves others unbadged", () => {
    expect(md).toContain("## Capabilities");
    expect(md).toMatch(/\| `logging` \| {2}\| `deprecated` \(SEP-2577; earliest removal on or after 2027-07-28 — log to stderr/);
    expect(md).toContain("| `tools` | `listChanged` |  |");
  });

  it("renders tool titles, skills and event types", () => {
    expect(md).toContain("### `get-user` — `read-only`\n\n**Get a user**");
    expect(md).toContain("## Skills");
    expect(md).toContain("| review | `skill://review/SKILL.md` | 1 | Review code |");
    expect(md).toContain("### `pr.opened` — `poll` `push`");
    expect(md).toContain("| `repo` | string | ✔ | owner/name |");
    expect(md).toContain("**Payload:** object");
  });

  it("emits none of the v2 sections for a contract that captured none of them (v1 output is unchanged)", () => {
    const plain = renderMarkdown({ version: 2, tools: [{ name: "a" }], resources: [], templates: [], prompts: [] });
    for (const h of ["## Extensions", "## Capabilities", "## Skills", "## Events", "**Protocol:**"]) expect(plain).not.toContain(h);
  });

  it("does not throw on boolean/null property schemas", () => {
    const c: Contract = { version: 2, tools: [{ name: "a", inputSchema: { type: "object", properties: { x: true as never, y: null as never } } }], resources: [], templates: [], prompts: [] };
    expect(() => renderMarkdown(c)).not.toThrow();
  });
});
