// Render a captured MCP capability surface as human-readable Markdown reference docs —
// "Redoc for MCP". Pure functions over a Contract; the CLI handles I/O. Renders tools
// (with annotation badges + an args table from each input JSON Schema), resources,
// resource templates, and prompts. From a v2 contract it also renders the protocol versions,
// server capabilities (with `deprecated` badges for SEP-2577 features), extensions with their
// revisions, tool titles, and the skills / event types a server advertises.

import { DEPRECATED_CAPABILITIES, type Contract, type ContractTool, type ContractPrompt } from "../../mcp-contract/src/contract.js";
import type { JSONSchema } from "../../mcp-contract/src/schema.js";

/** A compact human type expression for a JSON Schema node. */
export function schemaType(s: JSONSchema | undefined): string {
  if (!s || typeof s !== "object") return "any"; // missing, or a boolean/malformed schema (SEP-2106)
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" \\| ");
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
    description: (typeof s?.description === "string" ? s.description : "").replace(/\n+/g, " ").trim(),
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
  if (t.title?.trim()) out.push(`**${t.title.trim()}**`, "");
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

const cell = (x: unknown): string => String(x ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

function protocolLine(c: Contract): string {
  const p = c.protocol;
  if (!p || (!p.negotiated && !p.supported?.length)) return "";
  const parts: string[] = [];
  if (p.era) parts.push(p.era === "modern" ? "modern era" : "legacy era");
  if (p.negotiated) parts.push(`negotiated \`${p.negotiated}\``);
  if (p.supported?.length) parts.push(`supports ${p.supported.map((v) => `\`${v}\``).join(", ")}`);
  return `**Protocol:** ${parts.join(" · ")}`;
}

/** `deprecated` badge text for a capability key, or undefined when it is not deprecated. */
function deprecatedBadge(key: string): string | undefined {
  const d = DEPRECATED_CAPABILITIES.find((x) => x.key === key);
  return d ? `\`deprecated\` (${d.sep}; earliest removal on or after 2027-07-28 — ${d.migration})` : undefined;
}

function capabilitiesSection(c: Contract): string[] {
  const caps = c.capabilities;
  if (!caps || !Object.keys(caps).length) return [];
  const rows = Object.entries(caps).map(([key, v]) => {
    const flags =
      v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).filter(([, x]) => x === true).map(([k]) => `\`${k}\``).join(", ") : "";
    return `| \`${key}\` | ${flags} | ${deprecatedBadge(key) ?? ""} |`;
  });
  return ["## Capabilities", "", "| Capability | Flags | Status |", "| --- | --- | --- |", ...rows, ""];
}

function extensionsSection(c: Contract): string[] {
  const ext = c.extensions;
  if (!ext || !Object.keys(ext).length) return [];
  const rows = Object.entries(ext).map(([id, settings]) => {
    const { revision, ...rest } = settings ?? {};
    const other = Object.keys(rest).length ? `\`${cell(JSON.stringify(rest))}\`` : "";
    return `| \`${id}\` | ${revision === undefined ? "" : `\`${cell(revision)}\``} | ${other} |`;
  });
  return ["## Extensions", "", "| Extension | Revision | Settings |", "| --- | --- | --- |", ...rows, ""];
}

function skillsSection(c: Contract): string[] {
  if (!c.skills?.length) return [];
  const out = ["## Skills", "", "| Skill | URI | Files | Description |", "| --- | --- | --- | --- |"];
  for (const s of c.skills) {
    const files = s.files === "dynamic" ? "dynamic" : s.files ? String(s.files.length) : "";
    out.push(`| ${cell(s.name)} | \`${s.uri}\` | ${files} | ${cell(s.description)} |`);
  }
  return [...out, ""];
}

function eventsSection(c: Contract): string[] {
  if (!c.events?.length) return [];
  const out = ["## Events", ""];
  for (const e of c.events) {
    out.push(`### \`${e.name}\`${e.delivery?.length ? ` — ${e.delivery.map((d) => `\`${d}\``).join(" ")}` : ""}`, "");
    if (e.description?.trim()) out.push(e.description.trim(), "");
    out.push("**Subscription arguments**", "", argsTable(e.inputSchema));
    if (e.payloadSchema) out.push("", `**Payload:** ${schemaType(e.payloadSchema)}`);
    out.push("");
  }
  return out;
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

  const protocol = protocolLine(contract);
  if (protocol) out.push(protocol, "");
  out.push(...capabilitiesSection(contract), ...extensionsSection(contract));

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

  out.push(...skillsSection(contract), ...eventsSection(contract));

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
