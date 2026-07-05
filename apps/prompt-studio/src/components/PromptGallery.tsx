// Prompt catalog — reactive to prompts/list_changed via usePromptList.
import { usePromptList } from "mcpq/react";

export function PromptGallery({ server, onPick }: { server: string; onPick: (name: string) => void }) {
  const { prompts } = usePromptList({ server });

  if (prompts.length === 0) {
    return <p className="muted">No prompts yet — waiting for the server’s catalog…</p>;
  }
  return (
    <div className="gallery">
      {prompts.map((p) => (
        <button key={p.name} className="card" onClick={() => onPick(p.name)}>
          <h3>{p.name}</h3>
          <p>{p.description ?? "no description"}</p>
          <footer>
            {(p.arguments ?? []).length === 0
              ? "no arguments"
              : (p.arguments ?? []).map((a) => (
                  <code key={a.name} className={a.required ? "arg required" : "arg"}>
                    {a.name}
                    {a.required ? "*" : ""}
                  </code>
                ))}
          </footer>
        </button>
      ))}
    </div>
  );
}
