import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { jsonSchemaToTS, generateToolTypes, generatePromptTypes, generateTemplateTypes } from "../src/codegen/generate.js";
import { generateFromClient } from "../src/codegen/cli.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { MockMCPServer } from "../src/testing/mockServer.js";

describe("jsonSchemaToTS", () => {
  it("maps primitives", () => {
    expect(jsonSchemaToTS({ type: "string" })).toBe("string");
    expect(jsonSchemaToTS({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTS({ type: "boolean" })).toBe("boolean");
  });

  it("maps enums to string literal unions", () => {
    expect(jsonSchemaToTS({ enum: ["a", "b"] })).toBe('"a" | "b"');
  });

  it("maps arrays", () => {
    expect(jsonSchemaToTS({ type: "array", items: { type: "string" } })).toBe("Array<string>");
  });

  it("maps objects with required/optional fields", () => {
    const out = jsonSchemaToTS({
      type: "object",
      properties: { title: { type: "string" }, count: { type: "number" } },
      required: ["title"],
    });
    expect(out).toContain("title: string;");
    expect(out).toContain("count?: number;");
  });

  it("maps anyOf to a union", () => {
    expect(jsonSchemaToTS({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
  });
});

describe("generateToolTypes", () => {
  const code = generateToolTypes([
    {
      name: "github.create_issue",
      description: "Create an issue",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          priority: { enum: ["low", "high"] },
        },
        required: ["title"],
      },
    },
    { name: "fs.read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ]);

  it("emits a tool map, a name union, and arg helpers", () => {
    expect(code).toContain("export interface GeneratedToolMap");
    expect(code).toContain('"github.create_issue"');
    expect(code).toContain("export type ToolName =");
    expect(code).toContain("export type ToolArgs<N extends ToolName>");
  });

  it("produces output that compiles as valid TypeScript under --strict", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpq-gen-"));
    const file = join(dir, "gen.ts");
    writeFileSync(file, code, "utf8");
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      module: ts.ModuleKind.NodeNext,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file);
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(messages).toEqual([]);
  });
});

describe("generatePromptTypes", () => {
  it("emits a prompt map with required/optional string args", () => {
    const out = generatePromptTypes([
      { name: "greet", arguments: [{ name: "name", required: true }, { name: "lang" }] },
    ]);
    expect(out).toContain("GeneratedPromptMap");
    expect(out).toContain("name: string;");
    expect(out).toContain("lang?: string;");
    expect(out).toContain("export type PromptName =");
  });
});

describe("generateTemplateTypes", () => {
  it("emits a union of template URIs", () => {
    expect(generateTemplateTypes([{ name: "t", uriTemplate: "db://{table}" }])).toContain('"db://{table}"');
  });
});

describe("generateFromClient", () => {
  it("drains a paginated tools/list and generates all tool names", async () => {
    const mock = new MockMCPServer({
      tools: Array.from({ length: 12 }, (_, i) => ({
        name: `tool_${i}`,
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
      })),
      pageSize: 5,
    });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(mock.transport());
    const code = await generateFromClient(client);
    for (let i = 0; i < 12; i++) expect(code).toContain(`"tool_${i}"`);
    await client.close();
  });
});
