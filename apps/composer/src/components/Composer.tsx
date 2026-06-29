// The Composer (bottom dock): a textarea for freeform text PLUS inserted tool/resource
// blocks. The user assembles a draft, then Send collapses it into ONE grounded user
// message. A trailing text block always exists so typing after a tool block works.

import { useEffect, useRef, useState } from "react";
import { BlockView } from "./BlockView.js";
import { ToolPalette } from "./ToolPalette.js";
import {
  draftHasContent,
  type Draft,
  type DraftAction,
  type ToolBlock,
  type ResourceBlock,
} from "../draft.js";
import type { ServerEntry } from "../servers.js";

export function Composer({
  draft,
  dispatch,
  servers,
  onSend,
  busy,
}: {
  draft: Draft;
  dispatch: (a: DraftAction) => void;
  servers: ServerEntry[];
  onSend: () => void;
  busy: boolean;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Ensure there's always a trailing text block to type into.
  useEffect(() => {
    const last = draft.blocks[draft.blocks.length - 1];
    if (!last || last.kind !== "text") {
      dispatch({ type: "addText" });
    }
  }, [draft.blocks, dispatch]);

  const trailingText = [...draft.blocks].reverse().find((b) => b.kind === "text");
  const blocksBeforeTrailing = trailingText
    ? draft.blocks.slice(0, draft.blocks.findIndex((b) => b.id === trailingText.id))
    : draft.blocks;

  function insertBlock(block: ToolBlock | ResourceBlock) {
    // Insert the grounded block *before* the trailing text block so the user keeps typing.
    if (trailingText) {
      // remove trailing, add block, re-add trailing text (preserving its content)
      dispatch({ type: "removeBlock", id: trailingText.id });
      dispatch({ type: "addBlock", block });
      dispatch({ type: "addBlock", block: { ...trailingText } });
    } else {
      dispatch({ type: "addBlock", block });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // "/" at the start of an empty textarea opens the palette.
    if (e.key === "/" && (e.currentTarget.value === "" )) {
      e.preventDefault();
      setPaletteOpen(true);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (draftHasContent(draft) && !busy) onSend();
    }
  }

  return (
    <div className="composer">
      {blocksBeforeTrailing.some((b) => b.kind !== "text") && (
        <div className="draft-blocks">
          {blocksBeforeTrailing.map((b) =>
            b.kind === "text" ? (
              b.text.trim() ? (
                <div key={b.id} className="block text-block faded">
                  {b.text}
                </div>
              ) : null
            ) : (
              <BlockView
                key={b.id}
                block={b}
                editable
                onChange={(patch) => dispatch({ type: "patchBlock", id: b.id, patch })}
                onRemove={() => dispatch({ type: "removeBlock", id: b.id })}
              />
            ),
          )}
        </div>
      )}

      <div className="composer-input">
        <textarea
          ref={textRef}
          className="composer-textarea"
          placeholder="Write a message…  (press / or ➕ Tool to insert a grounded MCP result · ⌘↵ to send)"
          value={trailingText && trailingText.kind === "text" ? trailingText.text : ""}
          onChange={(e) =>
            trailingText && dispatch({ type: "setText", id: trailingText.id, text: e.target.value })
          }
          onKeyDown={onKeyDown}
          rows={3}
        />
        <div className="composer-bar">
          <button className="tool-add" onClick={() => setPaletteOpen(true)}>
            ➕ Tool
          </button>
          <div className="spacer" />
          <button
            className="send-btn"
            onClick={onSend}
            disabled={!draftHasContent(draft) || busy}
            title="Send (⌘↵)"
          >
            {busy ? "Sending…" : "Send ↵"}
          </button>
        </div>
      </div>

      {paletteOpen && (
        <ToolPalette
          servers={servers}
          onInsert={insertBlock}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
