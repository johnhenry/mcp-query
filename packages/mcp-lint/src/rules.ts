// Lint rules — absolute, single-version *quality* checks over an MCP capability surface.
// Complementary to mcp-contract (which checks *drift* between two versions): lint asks
// "is this surface well-designed?", contract asks "did it change incompatibly?". Both run
// on the same captured Contract.

import { DEPRECATED_CAPABILITIES, type Contract, type ContractTool, type CacheHint } from "../../mcp-contract/src/contract.js";

export type Severity = "error" | "warn" | "off";

export interface Rule {
  id: string;
  description: string;
  defaultSeverity: Severity;
  /** Return one entry per violation; severity is applied by the linter. */
  check: (c: Contract) => Array<{ target: string; message: string }>;
}

// Heuristic verb detection over tool names (matches kebab/snake/camel segment boundaries).
const READ = /(^|[-_/]|\b)(get|list|read|search|fetch|find|query|describe|count)([-_/]|s\b|\b|[A-Z])/i;
const DESTRUCTIVE = /(^|[-_/]|\b)(delete|remove|drop|destroy|truncate|purge|reset|revoke|wipe)([-_/]|\b|[A-Z])/i;

function undocumentedProps(t: ContractTool): string[] {
  const props = t.inputSchema?.properties;
  if (!props) return [];
  return Object.entries(props)
    .filter(([, s]) => !(s as { description?: string } | null)?.description?.trim())
    .map(([k]) => k);
}

function convention(name: string): string | null {
  if (name.includes("-")) return "kebab-case";
  if (name.includes("_")) return "snake_case";
  if (/[a-z][A-Z]/.test(name)) return "camelCase";
  return null; // single lowercase word — ambiguous, ignore
}

export const RULES: Rule[] = [
  {
    id: "tool-description",
    description: "Every tool has a non-empty description.",
    defaultSeverity: "error",
    check: (c) => c.tools.filter((t) => !t.description?.trim()).map((t) => ({ target: t.name, message: "tool has no description" })),
  },
  {
    id: "tool-input-described",
    description: "Each tool input property has a description.",
    defaultSeverity: "warn",
    check: (c) => c.tools.flatMap((t) => undocumentedProps(t).map((p) => ({ target: t.name, message: `input "${p}" has no description` }))),
  },
  {
    id: "destructive-annotation",
    description: "Tools whose name implies deletion set destructiveHint.",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools
        .filter((t) => DESTRUCTIVE.test(t.name) && t.annotations?.destructiveHint !== true)
        .map((t) => ({ target: t.name, message: "name implies a destructive action but destructiveHint is not set" })),
  },
  {
    id: "read-only-annotation",
    description: "Read-style tools set readOnlyHint.",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools
        .filter((t) => READ.test(t.name) && t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint !== true)
        .map((t) => ({ target: t.name, message: "name implies a read-only action but readOnlyHint is not set" })),
  },
  {
    id: "no-open-input",
    description: "Tool inputs are typed (no additionalProperties: true).",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools
        .filter((t) => t.inputSchema?.additionalProperties === true)
        .map((t) => ({ target: t.name, message: "input schema allows arbitrary additionalProperties (untyped)" })),
  },
  {
    id: "resource-mime-type",
    description: "Resources declare a mimeType.",
    defaultSeverity: "warn",
    check: (c) => c.resources.filter((r) => !r.mimeType).map((r) => ({ target: r.uri, message: "resource has no mimeType" })),
  },
  {
    id: "prompt-description",
    description: "Prompts have a description.",
    defaultSeverity: "warn",
    check: (c) => c.prompts.filter((p) => !p.description?.trim()).map((p) => ({ target: p.name, message: "prompt has no description" })),
  },
  {
    id: "naming-consistency",
    description: "Tool names use a single naming convention.",
    defaultSeverity: "warn",
    check: (c) => {
      const conventions = new Set(c.tools.map((t) => convention(t.name)).filter((x): x is string => !!x));
      return conventions.size > 1 ? [{ target: "(server)", message: `tool names mix conventions: ${[...conventions].sort().join(", ")}` }] : [];
    },
  },

  // ── 2026-07-28 surface (all `warn` by default so existing CI does not break) ──────────
  // Every rule below is evaluated from the captured contract alone. Contracts captured before
  // format v2 lack the fields these rules read, so those rules stay silent on them.
  {
    id: "deprecated-feature",
    description:
      "Server declares a feature deprecated by SEP-2577 (logging; also sampling/roots if they appear in its capabilities). Earliest removal: first revision on or after 2027-07-28 (SEP-2596).",
    defaultSeverity: "warn",
    check: (c) =>
      DEPRECATED_CAPABILITIES.filter((d) => c.capabilities && d.key in c.capabilities).map((d) => ({
        target: `capabilities.${d.key}`,
        message: `server declares "${d.key}", deprecated since 2026-07-28 (${d.sep}), earliest removal on or after 2027-07-28 (SEP-2596); migrate: ${d.migration}`,
      })),
  },
  {
    id: "cache-hints",
    description: "On a 2026-07-28 connection, server/discover and the list calls carry ttlMs and cacheScope (SEP-2549).",
    defaultSeverity: "warn",
    check: (c) => {
      if (!isModern(c)) return []; // 2025-era servers have no cache hints to carry
      const out: Array<{ target: string; message: string }> = [];
      for (const [name, hint] of Object.entries(c.cacheHints ?? {}) as Array<[string, CacheHint | undefined]>) {
        if (!hint) continue;
        const missing = [hint.ttlMs === undefined ? "ttlMs" : "", hint.cacheScope === undefined ? "cacheScope" : ""].filter(Boolean);
        if (missing.length) out.push({ target: CACHE_TARGETS[name] ?? name, message: `result is missing ${missing.join(" and ")} (required by SEP-2549)` });
      }
      return out;
    },
  },
  {
    id: "tool-name-format",
    description: "Tool names are 1-128 characters from A-Z a-z 0-9 _ - . (SEP-986) and unique within the server.",
    defaultSeverity: "warn",
    check: (c) => {
      const out: Array<{ target: string; message: string }> = [];
      const seen = new Set<string>();
      for (const t of c.tools) {
        if (!TOOL_NAME.test(t.name)) {
          const why = t.name.length === 0 ? "is empty" : t.name.length > 128 ? `is ${t.name.length} characters (max 128)` : "contains characters outside A-Z a-z 0-9 _ - .";
          out.push({ target: t.name || "(empty)", message: `tool name ${why} (SEP-986)` });
        }
        if (seen.has(t.name)) out.push({ target: t.name, message: "duplicate tool name (SEP-986: names SHOULD be unique within a server)" });
        seen.add(t.name);
      }
      return out;
    },
  },
  {
    id: "tool-title-icons",
    description: "Tools set a human-readable title, and any icons use https:/data: URIs with a valid theme and WxH sizes (SEP-973).",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools.flatMap((t) => {
        const out: Array<{ target: string; message: string }> = [];
        if (!t.title?.trim()) out.push({ target: t.name, message: "tool has no title (SEP-973 display name)" });
        (t.icons ?? []).forEach((icon, i) => {
          const where = `icons[${i}]`;
          if (typeof icon?.src !== "string" || !icon.src.trim()) out.push({ target: t.name, message: `${where} has no src` });
          else if (!/^(https:\/\/|data:)/i.test(icon.src.trim())) out.push({ target: t.name, message: `${where}.src must be an https: or data: URI (got "${icon.src.slice(0, 40)}")` });
          if (icon?.theme !== undefined && icon.theme !== "light" && icon.theme !== "dark") out.push({ target: t.name, message: `${where}.theme must be "light" or "dark"` });
          for (const size of icon?.sizes ?? []) {
            if (size !== "any" && !/^\d+x\d+$/.test(size)) out.push({ target: t.name, message: `${where}.sizes entry "${size}" must be WxH or "any"` });
          }
        });
        return out;
      }),
  },
  {
    id: "schema-dialect",
    description: "inputSchema/outputSchema are valid JSON Schema 2020-12 objects: root is an object schema, no foreign $schema, no pre-2020-12 tuple/dependency keywords (SEP-2106).",
    defaultSeverity: "warn",
    check: (c) =>
      c.tools.flatMap((t) =>
        (["inputSchema", "outputSchema"] as const).flatMap((field) => {
          const schema = t[field] as unknown;
          if (schema === undefined) return [];
          const target = `${t.name} ${field}`;
          if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
            // outputSchema may be `true`/`false` (boolean schemas); inputSchema MUST be an object.
            return field === "outputSchema" && typeof schema === "boolean" ? [] : [{ target, message: "schema must be a JSON Schema object (SEP-2106)" }];
          }
          const root = schema as Record<string, unknown>;
          const out: Array<{ target: string; message: string }> = [];
          if (field === "inputSchema" && root.type !== "object") out.push({ target, message: 'inputSchema root must have "type": "object"' });
          const dialect = root.$schema;
          if (dialect !== undefined) {
            if (typeof dialect !== "string" || !DIALECT_2020_12.test(dialect)) {
              out.push({ target, message: `declares $schema ${JSON.stringify(dialect)}; JSON Schema 2020-12 is the default and recommended dialect (SEP-2106)` });
            }
            return out; // an explicit foreign dialect is judged by its own keywords
          }
          for (const kw of legacyKeywords(root)) out.push({ target, message: `uses "${kw}", which is not valid in 2020-12 (the default dialect)` });
          return out;
        }),
      ),
  },
  {
    id: "x-mcp-header",
    description: "x-mcp-header values are valid, case-insensitively unique header names on top-level-reachable primitive properties (SEP-2243).",
    defaultSeverity: "warn",
    check: (c) => c.tools.flatMap((t) => xMcpHeaderProblems(t).map((message) => ({ target: t.name, message }))),
  },
  {
    id: "skills-manifest",
    description: "Skills have name/description frontmatter matching their directory, a SKILL.md in a manifest within 512 files / 16 MiB, and skill:// URIs (SEP-2640).",
    defaultSeverity: "warn",
    check: (c) =>
      (c.skills ?? []).flatMap((s) => {
        const out: Array<{ target: string; message: string }> = [];
        const add = (message: string) => out.push({ target: s.uri, message });
        if (!s.name?.trim()) add("SKILL.md frontmatter has no name");
        if (!s.description?.trim()) add("SKILL.md frontmatter has no description");
        const segments = s.uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/");
        const dir = segments.length >= 2 ? segments[segments.length - 2] : undefined;
        if (s.name && dir && s.name !== dir) add(`frontmatter name "${s.name}" must match its directory "${dir}"`);
        if (!s.uri.startsWith("skill://")) add("URI SHOULD use the skill:// scheme");
        if (Array.isArray(s.files)) {
          if (!s.files.some((f) => f.uri === s.uri)) add("manifest does not list SKILL.md itself");
          if (s.files.length > 512) add(`manifest lists ${s.files.length} files (SHOULD NOT exceed 512)`);
          const total = s.files.reduce((n, f) => n + (f.size ?? 0), 0);
          if (total > 16 * 1024 * 1024) add(`manifest totals ${total} bytes (SHOULD NOT exceed 16 MiB)`);
          for (const f of s.files) if (!f.digest) add(`manifest entry ${f.uri} has no digest`);
        }
        return out;
      }),
  },
  {
    id: "x-mcp-file",
    description:
      "EXPERIMENTAL (io.modelcontextprotocol/files draft; no SEP): an x-mcp-file argument declares accept (a list of media types) and maxSize (a positive byte count), so a client can pick and bound the file before sending it.",
    defaultSeverity: "warn",
    check: (c) => c.tools.flatMap((t) => xMcpFileProblems(t).map((message) => ({ target: t.name, message }))),
  },
];

// ── helpers for the 2026-07-28 rules ─────────────────────────────────────────

const CACHE_TARGETS: Record<string, string> = {
  discover: "server/discover",
  tools: "tools/list",
  resources: "resources/list",
  templates: "resources/templates/list",
  prompts: "prompts/list",
};

/** First revision to define server/discover and cache hints. */
const MODERN_FLOOR = "2026-07-28";

function isModern(c: Contract): boolean {
  if (c.protocol?.era) return c.protocol.era === "modern";
  const versions = [c.protocol?.negotiated, ...(c.protocol?.supported ?? [])].filter((v): v is string => !!v);
  return versions.some((v) => v >= MODERN_FLOOR);
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const DIALECT_2020_12 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/;

/** Keywords that were removed or reshaped by 2020-12, found anywhere under the schema. */
function legacyKeywords(schema: unknown, found = new Set<string>(), depth = 0): string[] {
  if (depth > 32 || typeof schema !== "object" || schema === null) return [...found];
  if (Array.isArray(schema)) {
    for (const item of schema) legacyKeywords(item, found, depth + 1);
    return [...found];
  }
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.items)) found.add("items (array form; use prefixItems)");
  if ("additionalItems" in node) found.add("additionalItems");
  if ("dependencies" in node) found.add("dependencies (use dependentRequired / dependentSchemas)");
  for (const [k, v] of Object.entries(node)) {
    if (k === "enum" || k === "const" || k === "default" || k === "examples") continue; // data, not schema
    legacyKeywords(v, found, depth + 1);
  }
  return [...found];
}

const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_PRIMITIVES = new Set(["string", "integer", "boolean"]);
// The final header is `Mcp-Param-{name}`; a value that spells a whole reserved header was almost certainly meant as one.
const RESERVED_HEADER = /^(mcp-method|mcp-name|mcp-param-.*)$/i;

function xMcpHeaderProblems(tool: ContractTool): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  const visit = (node: unknown, path: string, reachable: boolean, depth: number): void => {
    if (depth > 32 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${path}[${i}]`, false, depth + 1));
      return;
    }
    const n = node as Record<string, unknown>;
    if ("x-mcp-header" in n) {
      const at = path || "(root)";
      const v = n["x-mcp-header"];
      if (typeof v !== "string" || v === "") out.push(`${at}: x-mcp-header must be a non-empty string`);
      else {
        if (!HEADER_TOKEN.test(v)) out.push(`${at}: x-mcp-header "${v}" is not a valid HTTP header token (RFC 9110 1*tchar)`);
        if (RESERVED_HEADER.test(v)) out.push(`${at}: x-mcp-header "${v}" collides with a reserved MCP header (the value is only the name part of Mcp-Param-{name})`);
        const key = v.toLowerCase();
        const prior = seen.get(key);
        if (prior !== undefined) out.push(`${at}: x-mcp-header "${v}" duplicates ${prior} (names are compared case-insensitively)`);
        else seen.set(key, at);
      }
      if (!reachable) out.push(`${at}: x-mcp-header is only allowed on properties reachable through "properties" keys alone (not items, oneOf/anyOf/allOf/not, if/then/else, or $ref)`);
      const type = Array.isArray(n.type) ? undefined : n.type;
      if (type === undefined || !HEADER_PRIMITIVES.has(String(type))) {
        out.push(`${at}: x-mcp-header requires a primitive type (string, integer or boolean; not number), got ${JSON.stringify(n.type)}`);
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "properties" && typeof v === "object" && v !== null && !Array.isArray(v)) {
        for (const [name, sub] of Object.entries(v)) visit(sub, path ? `${path}.${name}` : name, reachable, depth + 1);
      } else if (k === "enum" || k === "const" || k === "default" || k === "examples") {
        continue;
      } else {
        visit(v, path ? `${path}.${k}` : k, false, depth + 1);
      }
    }
  };
  visit(tool.inputSchema, "", true, 0);
  return out;
}

/** EXPERIMENTAL files extension: every `x-mcp-file` (at any depth: array items and anyOf/oneOf are allowed by the draft) should declare `accept` and `maxSize`. */
function xMcpFileProblems(tool: ContractTool): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 32 || typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${path}[${i}]`, depth + 1));
      return;
    }
    const n = node as Record<string, unknown>;
    if ("x-mcp-file" in n) {
      const at = path || "(root)";
      const d = n["x-mcp-file"];
      if (typeof d !== "object" || d === null || Array.isArray(d)) {
        out.push(`${at}: x-mcp-file should be an object { accept, maxSize }`);
      } else {
        const { accept, maxSize } = d as { accept?: unknown; maxSize?: unknown };
        if (!Array.isArray(accept) || accept.length === 0 || !accept.every((a) => typeof a === "string" && a !== "")) {
          out.push(`${at}: x-mcp-file does not declare accept (a non-empty list of media types or .extensions)`);
        }
        if (typeof maxSize !== "number" || !Number.isFinite(maxSize) || maxSize <= 0) out.push(`${at}: x-mcp-file does not declare maxSize (a positive number of bytes)`);
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "enum" || k === "const" || k === "default" || k === "examples") continue;
      if (k === "properties" && typeof v === "object" && v !== null && !Array.isArray(v)) {
        for (const [name, sub] of Object.entries(v)) visit(sub, path ? `${path}.${name}` : name, depth + 1);
      } else visit(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(tool.inputSchema, "", 0);
  return out;
}
