// One card per pending interaction. Renders the right editor for the interaction's
// type + phase, and wires Approve / Deny (with an optional reason) to resolve().

import { useState } from "react";
import { SchemaForm, type JSONSchemaLike } from "@app-shared";
import type { Interaction, InteractionDecision } from "mcp-query";
import { ago } from "../time.js";

interface Props {
  interaction: Interaction;
  resolve: (id: number, decision: InteractionDecision) => void;
}

type SamplingMessage = { role: string; content: { type: string; text?: string } };

function messageText(m: SamplingMessage): string {
  return m.content?.text ?? JSON.stringify(m.content);
}

export function InteractionCard({ interaction, resolve }: Props) {
  const { id, type, phase, server, payload, manual } = interaction;
  const [reason, setReason] = useState("");

  // Sampling request payload → editable messages.
  const samplingMessages: SamplingMessage[] =
    type === "sampling" && phase === "request"
      ? ((payload as { messages?: SamplingMessage[] }).messages ?? [])
      : [];
  const [editedText, setEditedText] = useState<string[]>(samplingMessages.map(messageText));

  // Sampling request also (manual mode) needs an authored result.
  const [authored, setAuthored] = useState("");

  // Sampling response (review) payload → editable result for redaction.
  const responseResult =
    type === "sampling" && phase === "response" ? (payload as { result?: unknown }).result : undefined;
  const [redacted, setRedacted] = useState<string>(() =>
    responseResult ? JSON.stringify(responseResult, null, 2) : "",
  );

  function approve(extra: Partial<InteractionDecision> = {}): void {
    resolve(id, { action: "approve", reason: reason || undefined, ...extra });
  }
  function deny(): void {
    resolve(id, { action: "deny", reason: reason || undefined });
  }

  const age = ago(interaction.createdAt);

  return (
    <article className="card" data-type={type}>
      <header className="card-head">
        <div className="card-title">
          <span className={`pill pill-${type}`}>{type}</span>
          {phase === "response" && <span className="pill pill-phase">response review</span>}
          {manual && <span className="pill pill-manual">manual</span>}
        </div>
        <div className="card-meta">
          <span className="server">{server}</span>
          <span className="dot">·</span>
          <span className="age" title={new Date(interaction.createdAt).toLocaleString()}>
            {age}
          </span>
        </div>
      </header>

      <div className="card-body">
        {type === "sampling" && phase === "request" && (
          <SamplingRequestEditor
            messages={samplingMessages}
            editedText={editedText}
            setEditedText={setEditedText}
            manual={!!manual}
            authored={authored}
            setAuthored={setAuthored}
            payload={payload}
          />
        )}

        {type === "sampling" && phase === "response" && (
          <ResponseReviewEditor redacted={redacted} setRedacted={setRedacted} />
        )}

        {type === "elicitation" && (
          <ElicitationEditor
            payload={payload}
            onSubmit={(content) => approve({ content })}
            onDeny={deny}
            reason={reason}
            setReason={setReason}
          />
        )}
      </div>

      {/* Elicitation handles its own submit (form). Others get the standard footer. */}
      {type !== "elicitation" && (
        <footer className="card-foot">
          <input
            className="reason"
            placeholder="Optional reason…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="actions">
            <button className="btn btn-deny" onClick={deny}>
              Deny
            </button>
            <button
              className="btn btn-approve"
              onClick={() => {
                if (type === "sampling" && phase === "request") {
                  // Edited messages (always) + authored result (manual mode).
                  const editedMessages = applyEdits(samplingMessages, editedText);
                  approve(
                    manual
                      ? {
                          editedMessages,
                          editedResult: authoredResult(authored),
                        }
                      : { editedMessages },
                  );
                } else if (type === "sampling" && phase === "response") {
                  approve({ editedResult: parseRedacted(redacted) });
                } else {
                  approve();
                }
              }}
              disabled={type === "sampling" && phase === "request" && manual && authored.trim() === ""}
            >
              Approve
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}

// ── editors ────────────────────────────────────────────────────────────────

function SamplingRequestEditor(props: {
  messages: SamplingMessage[];
  editedText: string[];
  setEditedText: (v: string[]) => void;
  manual: boolean;
  authored: string;
  setAuthored: (v: string) => void;
  payload: unknown;
}) {
  const { messages, editedText, setEditedText, manual, authored, setAuthored, payload } = props;
  const sys = (payload as { systemPrompt?: string }).systemPrompt;
  return (
    <div className="sampling">
      {sys && (
        <p className="sys">
          <span className="label">system</span> {sys}
        </p>
      )}
      <div className="messages">
        {messages.map((m, i) => (
          <label key={i} className="msg">
            <span className={`role role-${m.role}`}>{m.role}</span>
            <textarea
              value={editedText[i] ?? ""}
              onChange={(e) => {
                const next = [...editedText];
                next[i] = e.target.value;
                setEditedText(next);
              }}
              rows={Math.min(6, Math.max(2, (editedText[i] ?? "").split("\n").length))}
            />
          </label>
        ))}
        {messages.length === 0 && <p className="empty-inline">No messages in this request.</p>}
      </div>
      {manual && (
        <label className="authored">
          <span className="label">Author the model response (you are the model)</span>
          <textarea
            value={authored}
            placeholder="Type the assistant reply the agent should receive…"
            onChange={(e) => setAuthored(e.target.value)}
            rows={4}
          />
        </label>
      )}
    </div>
  );
}

function ResponseReviewEditor(props: { redacted: string; setRedacted: (v: string) => void }) {
  return (
    <div className="response">
      <p className="hint">Review the model's result before it returns to the agent. Edit to redact.</p>
      <textarea
        className="redact"
        value={props.redacted}
        onChange={(e) => props.setRedacted(e.target.value)}
        rows={8}
      />
    </div>
  );
}

function ElicitationEditor(props: {
  payload: unknown;
  onSubmit: (content: Record<string, unknown>) => void;
  onDeny: () => void;
  reason: string;
  setReason: (v: string) => void;
}) {
  const { message, requestedSchema } = props.payload as {
    message?: string;
    requestedSchema?: JSONSchemaLike;
  };
  const empty = !requestedSchema?.properties || Object.keys(requestedSchema.properties).length === 0;
  return (
    <div className="elicitation">
      {message && <p className="message">{message}</p>}
      {empty ? (
        <div className="confirm-row">
          <input
            className="reason"
            placeholder="Optional reason…"
            value={props.reason}
            onChange={(e) => props.setReason(e.target.value)}
          />
          <div className="actions">
            <button className="btn btn-deny" onClick={props.onDeny}>
              Deny
            </button>
            <button className="btn btn-approve" onClick={() => props.onSubmit({})}>
              Approve
            </button>
          </div>
        </div>
      ) : (
        <>
          <SchemaForm schema={requestedSchema} submitLabel="Approve & submit" onSubmit={(v) => props.onSubmit(v)} />
          <div className="elicit-deny">
            <input
              className="reason"
              placeholder="Optional reason…"
              value={props.reason}
              onChange={(e) => props.setReason(e.target.value)}
            />
            <button className="btn btn-deny" onClick={props.onDeny}>
              Deny request
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function applyEdits(messages: SamplingMessage[], texts: string[]): SamplingMessage[] {
  return messages.map((m, i) => ({
    role: m.role,
    content: { type: "text", text: texts[i] ?? messageText(m) },
  }));
}

function authoredResult(text: string): unknown {
  return {
    role: "assistant",
    content: { type: "text", text },
    model: "human-in-the-loop",
    stopReason: "endTurn",
  };
}

function parseRedacted(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not valid JSON — wrap as a text result so the redaction still applies.
    return { role: "assistant", content: { type: "text", text }, model: "human-in-the-loop", stopReason: "endTurn" };
  }
}
