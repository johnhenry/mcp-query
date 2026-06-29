// Render a captured MCP capability surface as human-readable Markdown reference docs —
// "Redoc for MCP". Pure functions over a Contract; the CLI handles I/O. Renders tools
// (with annotation badges + an args table from each input JSON Schema), resources,
// resource templates, and prompts.

import type { Contract, ContractTool, ContractPrompt } from "../../mcp-contract/src/contract.js";
import type { JSONSchema } from "../../mcp-contract/src/schema.js";

/** A compact human type expression for a JSON Schema node. */
export function schemaType(s: JSONSchema | undefined): string {
  if (!s) return "any";
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" \\| ");
  const t = Array.isArray(s.type) ? s.type.join(" \\| ") : s.type;
  if (t === "array") return `${schemaType(s.items)}[]`;
  return t ?? "object";
}

interface ArgRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

function argRows(schema: JSONSchema | undefined): ArgRow[] {
  const props = schema?.properties;
  if (!props) return [];
  const required = new Set(schema?.required ?? []);
  return Object.entries(props).map(([name, s]) => ({
    name,
    type: schemaType(s),
    required: required.has(name),
    description: (s.description ?? "").replace(/\n+/g, " ").trim(),
  }));
}

function argsTable(schema: JSONSchema | undefined): string {
  const rows = argRows(schema);
  if (!rows.length) return "_No arguments._";
  const head = "| Argument | Type | Required | Description |\n| --- | --- | :---: | --- |";
  const body = rows
    .map((r) => `| \`${r.name}\` | ${r.type} | ${r.required ? "✔" : ""} | ${r.description} |`)
    .join("\n");
  return `${head}\n${body}`;
}

function badges(t: ContractTool): string {
  const a = t.annotations;
  if (!a) return "";
  const b: string[] = [];
  if (a.readOnlyHint) b.push("`read-only`");
  if (a.destructiveHint) b.push("`destructive`");
  if (a.idempotentHint) b.push("`idempotent`");
  return b.length ? ` — ${b.join(" ")}` : "";
}

function toolSection(t: ContractTool): string {
  const out = [`### \`${t.name}\`${badges(t)}`, ""];
  if (t.description?.trim()) out.push(t.description.trim(), "");
  out.push(argsTable(t.inputSchema));
  if (t.outputSchema) out.push("", `**Returns:** ${schemaType(t.outputSchema)}`);
  return out.join("\n");
}

function promptSection(p: ContractPrompt): string {
  const out = [`### \`${p.name}\``, ""];
  if (p.description?.trim()) out.push(p.description.trim(), "");
  if (p.arguments?.length) {
    out.push("| Argument | Required |", "| --- | :---: |");
    for (const a of p.arguments) out.push(`| \`${a.name}\` | ${a.required ? "✔" : ""} |`);
  } else {
    out.push("_No arguments._");
  }
  return out.join("\n");
}

export interface RenderOptions {
  /** Heading title; defaults to the recorded server name/version. */
  title?: string;
}

/** Render the whole contract as a Markdown document. */
export function renderMarkdown(contract: Contract, opts: RenderOptions = {}): string {
  const id = contract.server ? `${contract.server.name ?? "MCP server"}${contract.server.version ? ` v${contract.server.version}` : ""}` : "MCP server";
  const title = opts.title ?? id;
  const counts = `${contract.tools.length} tools · ${contract.resources.length} resources · ${contract.templates.length} templates · ${contract.prompts.length} prompts`;

  const out = [`# ${title}`, "", `> ${counts}`, ""];

  if (contract.tools.length) {
    out.push("## Tools", "");
    for (const t of contract.tools) out.push(toolSection(t), "");
  }
  if (contract.resources.length) {
    out.push("## Resources", "", "| URI | Name | MIME type |", "| --- | --- | --- |");
    for (const r of contract.resources) out.push(`| \`${r.uri}\` | ${r.name ?? ""} | ${r.mimeType ?? ""} |`);
    out.push("");
  }
  if (contract.templates.length) {
    out.push("## Resource templates", "", "| URI template | Name |", "| --- | --- |");
    for (const t of contract.templates) out.push(`| \`${t.uriTemplate}\` | ${t.name ?? ""} |`);
    out.push("");
  }
  if (contract.prompts.length) {
    out.push("## Prompts", "");
    for (const p of contract.prompts) out.push(promptSection(p), "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
