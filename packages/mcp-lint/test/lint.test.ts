import { describe, it, expect } from "vitest";
import type { Contract } from "../../mcp-contract/src/contract.js";
import { lintContract } from "../src/lint.js";
import { RULES } from "../src/rules.js";

const base: Contract = { version: 2, tools: [], resources: [], templates: [], prompts: [] };
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
      tools: [{ name: "get-user", title: "Get user", description: "Fetch a user", inputSchema: { type: "object", properties: { id: { type: "string", description: "user id" } }, required: ["id"] }, annotations: { readOnlyHint: true } }],
      resources: [{ uri: "file:///a", mimeType: "text/plain" }],
      prompts: [{ name: "greet", description: "Say hi" }],
    };
    expect(lintContract(c).findings).toEqual([]);
  });
});

// ── 2026-07-28 surface rules ────────────────────────────────────────────────
const tool = (over: Partial<Contract["tools"][number]> = {}): Contract["tools"][number] => ({ name: "get-user", title: "Get user", description: "d", ...over });
const withTools = (...tools: Contract["tools"]): Contract => ({ ...base, tools });
const msgs = (c: Contract, rule: string) => find(c, rule).map((f) => f.message);

describe("2026-07-28 rules: shape", () => {
  const NEW = ["deprecated-feature", "cache-hints", "tool-name-format", "tool-title-icons", "schema-dialect", "x-mcp-header", "skills-manifest"];
  it("registers each rule as warn by default and cites its SEP", () => {
    for (const id of NEW) {
      const r = RULES.find((x) => x.id === id);
      expect(r, id).toBeDefined();
      expect(r!.defaultSeverity).toBe("warn");
      expect(r!.description).toMatch(/SEP-\d+/);
    }
  });
  it("is silent on a contract that captured none of the v2-only fields", () => {
    const v1ish: Contract = { ...base, tools: [{ name: "a", title: "A", description: "d", inputSchema: { type: "object" } }] };
    expect(lintContract(v1ish).findings).toEqual([]);
  });
});

describe("deprecated-feature (SEP-2577 / SEP-2596)", () => {
  it("fails when the server declares logging, sampling or roots", () => {
    const c: Contract = { ...base, capabilities: { tools: {}, logging: {}, sampling: {} } };
    const f = find(c, "deprecated-feature");
    expect(f.map((x) => x.target).sort()).toEqual(["capabilities.logging", "capabilities.sampling"]);
    expect(f[0]!.message).toContain("SEP-2577");
    expect(f[0]!.severity).toBe("warn");
  });
  it("passes without deprecated capabilities (or when capabilities were not captured)", () => {
    expect(find({ ...base, capabilities: { tools: {}, resources: {} } }, "deprecated-feature")).toEqual([]);
    expect(find(base, "deprecated-feature")).toEqual([]);
  });
});

describe("cache-hints (SEP-2549)", () => {
  it("fails on a modern connection when a list result lacks ttlMs/cacheScope", () => {
    const c: Contract = { ...base, protocol: { era: "modern" }, cacheHints: { discover: { ttlMs: 1000, cacheScope: "public" }, tools: { ttlMs: 5 }, prompts: {} } };
    const f = find(c, "cache-hints");
    expect(f.map((x) => [x.target, x.message])).toEqual([
      ["tools/list", "result is missing cacheScope (required by SEP-2549)"],
      ["prompts/list", "result is missing ttlMs and cacheScope (required by SEP-2549)"],
    ]);
  });
  it("passes when every hint is present, and on legacy-era or uncaptured contracts", () => {
    const hint = { ttlMs: 0, cacheScope: "private" as const };
    expect(find({ ...base, protocol: { era: "modern" }, cacheHints: { tools: hint, templates: hint } }, "cache-hints")).toEqual([]);
    expect(find({ ...base, protocol: { era: "legacy" }, cacheHints: { tools: {} } }, "cache-hints")).toEqual([]);
    expect(find({ ...base, cacheHints: { tools: {} } }, "cache-hints")).toEqual([]);
    // era inferred from supported versions when `era` is absent
    expect(find({ ...base, protocol: { supported: ["2026-07-28"] }, cacheHints: { tools: {} } }, "cache-hints")).toHaveLength(1);
  });
});

describe("tool-name-format (SEP-986)", () => {
  it("fails on spaces, commas, over-long, empty and duplicate names", () => {
    const c = withTools(tool({ name: "bad name" }), tool({ name: "a,b" }), tool({ name: "x".repeat(129) }), tool({ name: "" }), tool({ name: "dup" }), tool({ name: "dup" }));
    const m = msgs(c, "tool-name-format");
    expect(m.some((x) => x.includes("outside A-Z a-z 0-9 _ - ."))).toBe(true);
    expect(m.filter((x) => x.includes("outside")).length).toBe(2);
    expect(m.some((x) => x.includes("129 characters (max 128)"))).toBe(true);
    expect(m.some((x) => x.includes("is empty"))).toBe(true);
    expect(m.some((x) => x.includes("duplicate"))).toBe(true);
  });
  it("passes on the spec's example names and a 128-character name", () => {
    expect(find(withTools(tool({ name: "getUser" }), tool({ name: "DATA_EXPORT_v2" }), tool({ name: "admin.tools.list" }), tool({ name: "y".repeat(128) })), "tool-name-format")).toEqual([]);
  });
});

describe("tool-title-icons (SEP-973)", () => {
  it("fails on a missing title and on unsafe or malformed icons", () => {
    const c = withTools(
      tool({ name: "notitle", title: undefined }),
      tool({ name: "badicons", icons: [{ src: "javascript:alert(1)" }, { src: "https://x/i.png", theme: "blue" as never, sizes: ["big"] }, { src: "" }] }),
    );
    const m = msgs(c, "tool-title-icons");
    expect(m).toContain("tool has no title (SEP-973 display name)");
    expect(m.some((x) => x.includes("icons[0].src must be an https: or data: URI"))).toBe(true);
    expect(m.some((x) => x.includes('icons[1].theme must be "light" or "dark"'))).toBe(true);
    expect(m.some((x) => x.includes('icons[1].sizes entry "big"'))).toBe(true);
    expect(m.some((x) => x.includes("icons[2] has no src"))).toBe(true);
  });
  it("passes with a title and well-formed icons (https, data:, WxH, any)", () => {
    const c = withTools(tool({ icons: [{ src: "https://x/i.png", sizes: ["48x48", "any"], theme: "dark" }, { src: "data:image/png;base64,AAAA" }] }));
    expect(find(c, "tool-title-icons")).toEqual([]);
  });
});

describe("schema-dialect (SEP-2106)", () => {
  it("fails on a foreign $schema, a non-object root, array-form items and legacy keywords", () => {
    const c = withTools(
      tool({ name: "draft7", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" } }),
      tool({ name: "notobj", inputSchema: { type: "string" } }),
      tool({ name: "tuple", inputSchema: { type: "object", properties: { p: { type: "array", items: [{ type: "string" }] as never } }, dependencies: { a: ["b"] } } }),
      tool({ name: "nullschema", inputSchema: null as never }),
    );
    const m = find(c, "schema-dialect").map((f) => `${f.target}: ${f.message}`);
    expect(m.some((x) => x.startsWith("draft7 inputSchema") && x.includes("draft-07"))).toBe(true);
    expect(m.some((x) => x.startsWith("notobj inputSchema") && x.includes('"type": "object"'))).toBe(true);
    expect(m.some((x) => x.startsWith("tuple inputSchema") && x.includes("items (array form"))).toBe(true);
    expect(m.some((x) => x.startsWith("tuple inputSchema") && x.includes("dependencies"))).toBe(true);
    expect(m.some((x) => x.startsWith("nullschema inputSchema") && x.includes("must be a JSON Schema object"))).toBe(true);
  });
  it("passes on 2020-12 schemas, boolean/array/primitive outputSchemas and a declared 2020-12 $schema", () => {
    const c = withTools(
      tool({ name: "a", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { t: { type: "array", prefixItems: [{ type: "string" }] } } } }),
      tool({ name: "b", inputSchema: { type: "object" }, outputSchema: { type: "array", items: { type: "string" } } }),
      tool({ name: "c", inputSchema: { type: "object" }, outputSchema: true as never }),
    );
    expect(find(c, "schema-dialect")).toEqual([]);
  });
});

describe("x-mcp-header (SEP-2243)", () => {
  const input = (props: Record<string, unknown>): never => ({ type: "object", properties: props }) as never;
  it("fails on invalid tokens, reserved names, case-insensitive duplicates, number types and unreachable placement", () => {
    const c = withTools(
      tool({
        name: "h",
        inputSchema: input({
          a: { type: "string", "x-mcp-header": "Bad Name" },
          b: { type: "string", "x-mcp-header": "Mcp-Method" },
          c: { type: "string", "x-mcp-header": "Region" },
          d: { type: "string", "x-mcp-header": "region" },
          e: { type: "number", "x-mcp-header": "Score" },
          f: { type: "array", items: { type: "string", "x-mcp-header": "Item" } },
          g: { type: "string", "x-mcp-header": "" },
        }),
      }),
    );
    const m = msgs(c, "x-mcp-header");
    expect(m.some((x) => x.includes('"Bad Name" is not a valid HTTP header token'))).toBe(true);
    expect(m.some((x) => x.includes('"Mcp-Method" collides with a reserved MCP header'))).toBe(true);
    expect(m.some((x) => x.includes('"region" duplicates'))).toBe(true);
    expect(m.some((x) => x.includes("requires a primitive type") && x.startsWith("e:"))).toBe(true);
    expect(m.some((x) => x.includes("only allowed on properties reachable") && x.includes("items"))).toBe(true);
    expect(m.some((x) => x.includes("non-empty string"))).toBe(true);
  });
  it("passes on valid, unique, reachable primitive properties (including nested properties)", () => {
    const c = withTools(
      tool({ inputSchema: input({ region: { type: "string", "x-mcp-header": "Region" }, n: { type: "integer", "x-mcp-header": "Count" }, o: { type: "object", properties: { deep: { type: "boolean", "x-mcp-header": "Deep" } } } }) }),
    );
    expect(find(c, "x-mcp-header")).toEqual([]);
  });
});

describe("skills-manifest (SEP-2640)", () => {
  const skill = (over: object = {}) => ({ uri: "skill://review/SKILL.md", name: "review", description: "d", files: [{ uri: "skill://review/SKILL.md", digest: "sha256:aa", size: 10 }], ...over });
  it("fails on missing frontmatter, name/dir mismatch, wrong scheme, missing SKILL.md and oversize manifests", () => {
    const many = Array.from({ length: 513 }, (_, i) => ({ uri: `skill://big/f${i}`, digest: "sha256:aa", size: 1 }));
    const c: Contract = {
      ...base,
      skills: [
        skill({ name: "", description: "" }),
        skill({ uri: "skill://x/SKILL.md", name: "y", files: [{ uri: "skill://x/other.md", digest: "sha256:aa", size: 1 }] }),
        skill({ uri: "https://h/review/SKILL.md", files: [{ uri: "https://h/review/SKILL.md", size: 17 * 1024 * 1024 }] }),
        { uri: "skill://big/SKILL.md", name: "big", description: "d", files: [{ uri: "skill://big/SKILL.md", digest: "sha256:aa", size: 1 }, ...many] },
      ],
    };
    const m = msgs(c, "skills-manifest");
    expect(m).toContain("SKILL.md frontmatter has no name");
    expect(m).toContain("SKILL.md frontmatter has no description");
    expect(m.some((x) => x.includes('name "y" must match its directory "x"'))).toBe(true);
    expect(m).toContain("manifest does not list SKILL.md itself");
    expect(m).toContain("URI SHOULD use the skill:// scheme");
    expect(m.some((x) => x.includes("exceed 16 MiB"))).toBe(true);
    expect(m.some((x) => x.includes("has no digest"))).toBe(true);
    expect(m.some((x) => x.includes("513") || x.includes("514 files"))).toBe(true);
  });
  it("passes on a well-formed skill and on contracts without skills", () => {
    expect(find({ ...base, skills: [skill(), { uri: "skill://dyn/SKILL.md", name: "dyn", description: "d", files: "dynamic" }] }, "skills-manifest")).toEqual([]);
    expect(find(base, "skills-manifest")).toEqual([]);
  });
});

describe("x-mcp-file (experimental files extension)", () => {
  const input = (props: Record<string, unknown>): never => ({ type: "object", properties: props }) as never;
  it("is a warn-level rule", () => {
    expect(RULES.find((x) => x.id === "x-mcp-file")).toMatchObject({ defaultSeverity: "warn" });
  });
  it("warns when accept or maxSize is missing or malformed, at any depth", () => {
    const c = withTools(
      tool({
        name: "up",
        inputSchema: input({
          a: { type: "object", "x-mcp-file": {} },
          b: { type: "object", "x-mcp-file": { accept: ["application/pdf"] } },
          c: { type: "object", "x-mcp-file": { maxSize: 100 } },
          d: { type: "array", items: { type: "object", "x-mcp-file": { accept: [], maxSize: -1 } } },
          e: { type: "object", "x-mcp-file": true },
        }),
      }),
    );
    const m = msgs(c, "x-mcp-file");
    expect(m.filter((x) => x.startsWith("a:"))).toHaveLength(2);
    expect(m.filter((x) => x.startsWith("b:") && x.includes("maxSize"))).toHaveLength(1);
    expect(m.filter((x) => x.startsWith("c:") && x.includes("accept"))).toHaveLength(1);
    expect(m.filter((x) => x.startsWith("d.items"))).toHaveLength(2);
    expect(m.some((x) => x.startsWith("e:") && x.includes("should be an object"))).toBe(true);
  });
  it("is silent for a complete declaration and for tools without file arguments", () => {
    const c = withTools(
      tool({ name: "ok", inputSchema: input({ f: { type: "object", "x-mcp-file": { accept: ["image/*", ".png"], maxSize: 1048576 } } }) }),
      tool({ name: "plain", inputSchema: input({ s: { type: "string" } }) }),
    );
    expect(msgs(c, "x-mcp-file")).toEqual([]);
  });
});
