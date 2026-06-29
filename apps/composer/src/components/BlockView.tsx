// Renders one grounded block inside the draft (or inside a sent user message). Tool and
// resource blocks show the call signature + ResultView, with re-run / trim / remove.

import { useState } from "react";
import { ResultView } from "@app-shared";
import { useMCPClient } from "mcp-query/react";
import {
  resultToText,
  serializeArgs,
  type Block,
  type ToolBlock,
  type ResourceBlock,
} from "../draft.js";

export function BlockView({
  block,
  editable,
  onChange,
  onRemove,
}: {
  block: Block;
  /** When false, the block is shown read-only (e.g. inside a sent message). */
  editable: boolean;
  onChange?: (patch: Partial<ToolBlock> & Partial<ResourceBlock>) => void;
  onRemove?: () => void;
}) {
  const client = useMCPClient();
  const [collapsed, setCollapsed] = useState(false);

  if (block.kind === "text") {
    // Text blocks are edited in the composer textarea, not here.
    return <div className="block text-block">{block.text}</div>;
  }

  // `gb` is the grounded block (tool or resource) — narrowed once so the closures below
  // keep the narrowed type.
  const gb: ToolBlock | ResourceBlock = block;

  const header =
    gb.kind === "tool"
      ? `${gb.server}.${gb.tool}(${serializeArgs(gb.args)})`
      : `${gb.server} · ${gb.name ?? gb.uri}`;

  async function rerun() {
    if (!onChange) return;
    onChange({ running: true, error: undefined });
    try {
      const result =
        gb.kind === "tool"
          ? await client.callTool(`${gb.server}.${gb.tool}`, gb.args)
          : await client.readResource(gb.uri, { server: gb.server });
      onChange({ result, running: false, error: undefined });
    } catch (e) {
      onChange({ running: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  function trim() {
    if (!onChange || gb.result === undefined) return;
    // "Trim" collapses the rich result down to its plain text, making the block lighter
    // and giving the user an editable, predictable payload for the model.
    onChange({ result: { content: [{ type: "text", text: resultToText(gb.result) }] } });
  }

  return (
    <div className={`block tool-block ${gb.kind}`}>
      <div className="block-head">
        <button className="block-toggle" onClick={() => setCollapsed((c) => !c)} title="Collapse">
          {collapsed ? "▸" : "▾"}
        </button>
        <code className="block-sig">
          {gb.kind === "tool" ? "🛠 " : "📄 "}
          {header}
        </code>
        {editable && (
          <span className="block-actions">
            <button className="mini" onClick={() => void rerun()} disabled={gb.running} title="Re-run">
              ↻
            </button>
            {gb.kind === "tool" && (
              <button className="mini" onClick={trim} disabled={gb.result === undefined} title="Trim to text">
                ✂
              </button>
            )}
            <button className="mini danger" onClick={onRemove} title="Remove">
              ✕
            </button>
          </span>
        )}
      </div>

      {!collapsed && (
        <div className="block-result">
          {gb.running && <p className="muted">Running…</p>}
          {gb.error && <p className="error-text">⚠ {gb.error}</p>}
          {!gb.error && gb.result !== undefined && (
            <ResultView value={extractResultValue(gb.result)} />
          )}
          {!gb.running && !gb.error && gb.result === undefined && (
            <p className="muted">(not run)</p>
          )}
        </div>
      )}
    </div>
  );
}

/** ResultView likes a content array; unwrap CallToolResult/ReadResourceResult to it. */
function extractResultValue(result: unknown): unknown {
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) return obj.content;
    if (Array.isArray(obj.contents)) return obj.contents;
  }
  return result;
}
