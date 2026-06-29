// The heart of Composer: a *draft* is an ordered list of blocks the user is assembling
// for ONE user message. Blocks are either freeform text or grounded results pulled from
// MCP — tool calls and resource reads. The user runs the tools themselves (tools as
// INPUT, not agent output), then sends the whole thing as a single grounded message.
//
// Everything here is pure (no React, no network) so it can be unit-tested directly.

export interface TextBlock {
  id: string;
  kind: "text";
  text: string;
}

export interface ToolBlock {
  id: string;
  kind: "tool";
  /** Connected server name, e.g. "everything". */
  server: string;
  /** Tool name, e.g. "get-sum". */
  tool: string;
  /** Arguments the user supplied via SchemaForm. */
  args: Record<string, unknown>;
  /** The tool result (raw MCP result; rendered via ResultView). undefined while running. */
  result?: unknown;
  /** Set if the call failed. */
  error?: string;
  /** True while a (re-)run is in flight. */
  running?: boolean;
}

export interface ResourceBlock {
  id: string;
  kind: "resource";
  server: string;
  uri: string;
  /** Display name of the resource, if known. */
  name?: string;
  result?: unknown;
  error?: string;
  running?: boolean;
}

export type Block = TextBlock | ToolBlock | ResourceBlock;

export interface Draft {
  blocks: Block[];
}

export function emptyDraft(): Draft {
  return { blocks: [] };
}

let _seq = 0;
/** Monotonic id generator (deterministic within a session; fine for keys). */
export function nextId(prefix = "b"): string {
  _seq += 1;
  return `${prefix}${_seq}`;
}

// ── reducer ───────────────────────────────────────────────────────────────────
// A small, pure reducer so the add/remove/edit/re-run paths are unit-testable.

export type DraftAction =
  | { type: "setText"; id: string; text: string }
  | { type: "addText"; text?: string }
  | { type: "addBlock"; block: Block }
  | { type: "removeBlock"; id: string }
  | { type: "patchBlock"; id: string; patch: Partial<ToolBlock> & Partial<ResourceBlock> }
  | { type: "clear" };

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case "setText":
      return {
        blocks: draft.blocks.map((b) =>
          b.id === action.id && b.kind === "text" ? { ...b, text: action.text } : b,
        ),
      };
    case "addText":
      return { blocks: [...draft.blocks, { id: nextId("t"), kind: "text", text: action.text ?? "" }] };
    case "addBlock":
      return { blocks: [...draft.blocks, action.block] };
    case "removeBlock":
      return { blocks: draft.blocks.filter((b) => b.id !== action.id) };
    case "patchBlock":
      return {
        blocks: draft.blocks.map((b) =>
          b.id === action.id ? ({ ...b, ...action.patch } as Block) : b,
        ),
      };
    case "clear":
      return emptyDraft();
    default:
      return draft;
  }
}

// ── serialization: draft → one grounded user message ───────────────────────────

/** Serialize tool args compactly: `a:2, b:3`. */
export function serializeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}:${compactValue(v)}`)
    .join(", ");
}

function compactValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Flatten an MCP result (content array, structured value, plain value) to text. */
export function resultToText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;

  // CallToolResult / ReadResourceResult: { content: [...] } or { contents: [...] }.
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    const content = (obj.content ?? obj.contents) as unknown;
    if (Array.isArray(content)) {
      const parts = content
        .map((block) => {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (typeof b.text === "string") return b.text;
            if (typeof b.blob === "string") return `[blob ${String(b.mimeType ?? "")}]`.trim();
            if (b.type === "image") return `[image ${String(b.mimeType ?? "")}]`.trim();
          }
          return safeJson(block);
        })
        .filter((s) => s.length > 0);
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return safeJson(result);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Assemble the draft into ONE user-message string: freeform text interleaved with each
 * block serialized as a labeled, fenced section, e.g.
 *
 *   here is the sum:
 *
 *   ‹tool everything.get-sum(a:2, b:3)›
 *   42
 *
 * Empty text blocks are skipped; blocks without a result yet are labeled accordingly.
 */
export function assembleMessage(draft: Draft): string {
  const parts: string[] = [];
  for (const block of draft.blocks) {
    if (block.kind === "text") {
      const t = block.text.trim();
      if (t) parts.push(t);
    } else if (block.kind === "tool") {
      const header = `‹tool ${block.server}.${block.tool}(${serializeArgs(block.args)})›`;
      const body = block.error
        ? `error: ${block.error}`
        : block.result === undefined
          ? "(not run)"
          : resultToText(block.result);
      parts.push(`${header}\n${body}`);
    } else {
      const header = `‹resource ${block.server} ${block.uri}›`;
      const body = block.error
        ? `error: ${block.error}`
        : block.result === undefined
          ? "(not read)"
          : resultToText(block.result);
      parts.push(`${header}\n${body}`);
    }
  }
  return parts.join("\n\n");
}

/** True if the draft has any sendable content. */
export function draftHasContent(draft: Draft): boolean {
  return draft.blocks.some(
    (b) =>
      (b.kind === "text" && b.text.trim().length > 0) ||
      (b.kind !== "text" && (b.result !== undefined || b.error !== undefined)),
  );
}
