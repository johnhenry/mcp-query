// The conversation thread. User messages render their freeform text plus the grounded
// blocks they carried (collapsible, read-only). Assistant messages stream in.

import { BlockView } from "./BlockView.js";
import type { Block } from "../draft.js";

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  /** Freeform/serialized text. */
  text: string;
  /** For user messages: the grounded blocks included (rendered read-only). */
  blocks?: Block[];
  /** True while an assistant message is still streaming. */
  streaming?: boolean;
  /** Set if the model call failed. */
  error?: string;
}

export function Thread({ messages }: { messages: ThreadMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="thread empty">
        <div className="empty-card">
          <h2>Compose grounded input</h2>
          <p>
            Write a message, then press <kbd>➕ Tool</kbd> to run an MCP tool and drop its{" "}
            <em>live result</em> straight into your draft. You drive the tools — the model
            only sees the finished, grounded message.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="thread">
      {messages.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          <div className="msg-role">{m.role === "user" ? "You" : "Assistant"}</div>
          <div className="msg-body">
            {m.role === "user" && m.blocks && m.blocks.length > 0 ? (
              <UserMessage blocks={m.blocks} />
            ) : (
              <div className="msg-text">
                {m.text}
                {m.streaming && <span className="caret">▍</span>}
              </div>
            )}
            {m.error && <p className="error-text">⚠ {m.error}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function UserMessage({ blocks }: { blocks: Block[] }) {
  return (
    <div className="user-message">
      {blocks.map((b) =>
        b.kind === "text" ? (
          b.text.trim() ? (
            <div key={b.id} className="msg-text">
              {b.text}
            </div>
          ) : null
        ) : (
          <BlockView key={b.id} block={b} editable={false} />
        ),
      )}
    </div>
  );
}
