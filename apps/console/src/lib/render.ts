// Pure render helpers — the operator-facing formatting that distinguishes the Console
// from the Inspector's raw JSON log. They take MCP results and produce HTML strings, so
// they can be unit-tested without mounting a custom element.

import { esc } from "@app-shared/reactive";

interface ContentText { type: "text"; text: string }
interface ContentImage { type: "image"; data: string; mimeType: string }
interface ContentResource { type: "resource"; resource?: { uri?: string; text?: string; mimeType?: string } }
type Content = ContentText | ContentImage | ContentResource | { type: string; [k: string]: unknown };

export interface ToolResult {
  content?: Content[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Coerce form values into the shape an MCP tool expects, given its inputSchema.
 *  buildSchemaForm already drops empty/undefined fields and parses JSON; this layer
 *  guarantees number/integer/boolean types even when a value arrives as a string. */
export function coerceArgs(
  values: Record<string, unknown>,
  schema: { properties?: Record<string, { type?: string | string[]; enum?: unknown[] }> } | undefined,
): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const t = typeArg(props[k]?.type);
    if (v === undefined || v === null || v === "") continue;
    if (t === "number" || t === "integer") {
      const n = typeof v === "number" ? v : Number(v);
      out[k] = Number.isNaN(n) ? v : t === "integer" ? Math.trunc(n) : n;
    } else if (t === "boolean") {
      out[k] = typeof v === "boolean" ? v : v === "true" || v === true;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function typeArg(t: string | string[] | undefined): string | undefined {
  return Array.isArray(t) ? t[0] : t;
}

/** True when every item is a flat object — those render best as a table. */
export function isTabular(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))
  );
}

/** Render an array of flat objects as an HTML table (union of keys = columns). */
export function renderTable(rows: Array<Record<string, unknown>>): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${cols.map((c) => `<td>${esc(cell(r[c]))}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table class="result-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Pretty-print arbitrary JSON inside a <pre>. */
export function renderJson(value: unknown): string {
  return `<pre class="output">${esc(JSON.stringify(value, null, 2))}</pre>`;
}

/** Render one MCP content block (text / image / embedded resource). */
function renderContentBlock(c: Content): string {
  if (c.type === "text") return `<div class="content-text">${esc((c as ContentText).text)}</div>`;
  if (c.type === "image") {
    const img = c as ContentImage;
    return `<img class="content-image" alt="tool image result" src="data:${esc(img.mimeType)};base64,${esc(img.data)}" />`;
  }
  if (c.type === "resource") {
    const r = (c as ContentResource).resource ?? {};
    return `<div class="content-resource"><div class="muted">${esc(r.uri ?? "")} ${r.mimeType ? `· ${esc(r.mimeType)}` : ""}</div>${
      r.text !== undefined ? `<pre class="output">${esc(r.text)}</pre>` : ""
    }</div>`;
  }
  return renderJson(c);
}

/** Render a full tool result for an operator: structured data → table/JSON, then any
 *  content blocks (text/image/resource). Error results get an error banner. */
export function renderToolResult(result: ToolResult): string {
  const parts: string[] = [];
  if (result.isError) parts.push(`<div class="result-error" role="alert">tool reported an error</div>`);

  // Prefer structuredContent when present; otherwise try to lift JSON out of a lone text block.
  const structured = result.structuredContent ?? liftedJson(result);
  if (structured !== undefined) {
    parts.push(isTabular(structured) ? renderTable(structured) : renderJson(structured));
  }

  for (const c of result.content ?? []) {
    // Skip a text block we already rendered as lifted JSON.
    if (structured !== undefined && c.type === "text" && result.structuredContent === undefined) continue;
    parts.push(renderContentBlock(c));
  }

  if (parts.length === 0) parts.push(`<p class="muted">no content returned</p>`);
  return `<div class="result">${parts.join("")}</div>`;
}

/** If the only content is a single text block holding JSON, parse it so we can table it. */
function liftedJson(result: ToolResult): unknown {
  const blocks = result.content ?? [];
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (blocks.length !== 1 || blocks[0]?.type !== "text") return undefined;
  const text = (blocks[0] as ContentText).text.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return undefined;
  try {
    const v = JSON.parse(text);
    return isTabular(v) || (v && typeof v === "object") ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Render resource contents (text blocks joined, JSON pretty-printed, blobs noted). */
export function renderResourceContents(data: unknown): string {
  const contents = (data as { contents?: Array<{ text?: string; blob?: string; mimeType?: string; uri?: string }> })?.contents;
  if (!Array.isArray(contents) || contents.length === 0) return renderJson(data);
  return contents
    .map((c) => {
      if (c.text !== undefined) return `<pre class="output">${esc(c.text)}</pre>`;
      if (c.blob !== undefined)
        return `<div class="content-resource"><div class="muted">binary blob · ${esc(c.mimeType ?? "")} · ${c.blob.length} b64 chars</div>${
          (c.mimeType ?? "").startsWith("image/")
            ? `<img class="content-image" alt="resource" src="data:${esc(c.mimeType!)};base64,${esc(c.blob)}" />`
            : ""
        }</div>`;
      return renderJson(c);
    })
    .join("");
}

/** Render prompt messages (role + content) as a readable transcript. */
export function renderPromptMessages(result: unknown): string {
  const r = result as { description?: string; messages?: Array<{ role?: string; content?: unknown }> };
  const msgs = r?.messages ?? [];
  const head = r?.description ? `<p class="muted">${esc(r.description)}</p>` : "";
  if (msgs.length === 0) return head + `<p class="muted">no messages</p>`;
  const body = msgs
    .map((m) => {
      const text = promptContentText(m.content);
      return `<div class="message message-${esc(m.role ?? "user")}"><span class="role">${esc(m.role ?? "user")}</span><div class="msg-body">${
        text !== undefined ? `<div class="content-text">${esc(text)}</div>` : renderJson(m.content)
      }</div></div>`;
    })
    .join("");
  return head + `<div class="transcript">${body}</div>`;
}

function promptContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "type" in content && (content as { type: string }).type === "text") {
    return (content as { text?: string }).text;
  }
  return undefined;
}
