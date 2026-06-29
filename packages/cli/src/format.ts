// Terminal output helpers — pure and testable (no console, no process).
//
// `formatResult` is the one renderer every client verb funnels through. Three modes:
//   • "human" — friendly: MCP content arrays become text (images noted), arrays of flat
//                objects become an aligned table, everything else is pretty JSON.
//   • "json"  — pretty JSON of the *value* (the meaningful payload).
//   • "raw"   — pretty JSON of the protocol object exactly as returned.
//
// `toolSignature` renders a tool as a one-line `name(arg: type, …)` plus its description.

import { schemaType } from "../../mcp-docs/src/render.js";
import type { JSONSchema } from "../../mcp-contract/src/schema.js";

export type OutputMode = "human" | "json" | "raw";

/** An MCP content block (text / image / resource / …). */
interface ContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string };
  [k: string]: unknown;
}

function isContentArray(v: unknown): v is ContentBlock[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && typeof (x as ContentBlock).type === "string");
}

/** Render a single MCP content block as a human line. */
function renderBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text ?? "";
    case "image":
      return `[image: ${b.mimeType ?? "image"} (${b.data ? b.data.length : 0} bytes)]`;
    case "audio":
      return `[audio: ${b.mimeType ?? "audio"}]`;
    case "resource": {
      const r = b.resource ?? {};
      return r.text ?? `[resource: ${r.uri ?? "?"}]`;
    }
    default:
      return JSON.stringify(b);
  }
}

/** True for an object whose values are all scalars (table-able row). */
function isFlatObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((x) => x === null || ["string", "number", "boolean", "undefined"].includes(typeof x));
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** Render an array of flat objects as an aligned, left-justified text table. */
function renderTable(rows: Array<Record<string, unknown>>): string {
  const cols: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - s.length));
  const header = cols.map((c, i) => pad(c, widths[i]!)).join("  ");
  const sep = cols.map((_, i) => "-".repeat(widths[i]!)).join("  ");
  const body = rows.map((r) => cols.map((c, i) => pad(cell(r[c]), widths[i]!)).join("  ").trimEnd());
  return [header, sep, ...body].join("\n");
}

/**
 * Render `value` for the terminal. In "json"/"raw" modes the whole value is pretty-printed
 * (raw is reserved for the protocol object; the caller passes the protocol object as `value`).
 */
export function formatResult(value: unknown, mode: OutputMode = "human"): string {
  if (mode === "json" || mode === "raw") return JSON.stringify(value, null, 2);

  // human
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (isContentArray(value)) return value.map(renderBlock).join("\n");
  if (Array.isArray(value) && value.length > 0 && value.every(isFlatObject)) {
    return renderTable(value as Array<Record<string, unknown>>);
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** A tool as advertised by the server (the subset we render). */
export interface ToolLike {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

/** One-line `name(arg: type, …)` signature, optionally followed by a wrapped description line. */
export function toolSignature(tool: ToolLike): string {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const args = Object.entries(props)
    .map(([name, s]) => `${name}${required.has(name) ? "" : "?"}: ${schemaType(s)}`)
    .join(", ");
  const sig = `${tool.name}(${args})`;
  const desc = (tool.description ?? "").replace(/\s+/g, " ").trim();
  return desc ? `${sig}\n    ${desc}` : sig;
}
