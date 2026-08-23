// Fill a prompt's arguments (with server-driven typeahead) and render the resulting
// message array as a chat-style transcript — prompts/get, actually used.
import { useMemo, useState } from "react";
import { usePrompt, usePromptList } from "@johnhenry/mcp-query/react";
import { JsonView } from "@app-shared";
import { CompletionInput } from "./CompletionInput.js";

interface PromptMessage {
  role?: string;
  content?: { type?: string; text?: string; resource?: { uri?: string; text?: string } } | string;
}

export function PromptRunner({ server, name, onBack }: { server: string; name: string; onBack: () => void }) {
  const { prompts } = usePromptList({ server });
  const def = prompts.find((p) => p.name === name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState<Record<string, string> | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const args = def?.arguments ?? [];

  return (
    <div className="runner">
      <div className="runner-head">
        <button onClick={onBack}>← back</button>
        <h2>{name}</h2>
        <span className="muted">{def?.description}</span>
      </div>

      <form
        className="arg-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted({ ...values });
        }}
      >
        {args.length === 0 && <p className="muted">This prompt takes no arguments.</p>}
        {args.map((a) => (
          <label key={a.name} className="field">
            <span>
              {a.name}
              {a.required ? " *" : ""}
              <em className="muted"> {a.description}</em>
            </span>
            <CompletionInput
              server={server}
              refFor={{ type: "ref/prompt", name }}
              argName={a.name}
              required={a.required}
              value={values[a.name] ?? ""}
              contextArgs={values}
              onChange={(v) => setValues((prev) => ({ ...prev, [a.name]: v }))}
            />
          </label>
        ))}
        <button type="submit" className="primary">
          Render prompt
        </button>
      </form>

      {submitted && <Transcript server={server} name={name} vars={submitted} showRaw={showRaw} onToggleRaw={() => setShowRaw((r) => !r)} />}
    </div>
  );
}

function Transcript({
  server,
  name,
  vars,
  showRaw,
  onToggleRaw,
}: {
  server: string;
  name: string;
  vars: Record<string, string>;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const result = usePrompt(name, vars, server);
  const messages = useMemo(() => (result.messages ?? []) as PromptMessage[], [result.messages]);

  if (!result.messages) return <p className="muted">Rendering…</p>;
  return (
    <section className="transcript">
      <header>
        <h3>{result.description ?? "messages"}</h3>
        <button onClick={onToggleRaw}>{showRaw ? "chat view" : "raw JSON"}</button>
      </header>
      {showRaw ? (
        <JsonView value={result} />
      ) : (
        messages.map((m, i) => (
          <div key={i} className={`bubble role-${m.role ?? "user"}`}>
            <span className="role">{m.role ?? "?"}</span>
            <MessageBody content={m.content} />
          </div>
        ))
      )}
    </section>
  );
}

function MessageBody({ content }: { content: PromptMessage["content"] }) {
  if (typeof content === "string") return <pre>{content}</pre>;
  if (content?.type === "text") return <pre>{content.text}</pre>;
  if (content?.type === "resource")
    return (
      <pre>
        <b>{content.resource?.uri}</b>
        {"\n"}
        {content.resource?.text}
      </pre>
    );
  return <JsonView value={content} />;
}
