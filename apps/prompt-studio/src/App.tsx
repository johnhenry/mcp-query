import { useState } from "react";
import { useMCPClient, useServerState } from "mcpq/react";
import { PromptGallery } from "./components/PromptGallery.js";
import { PromptRunner } from "./components/PromptRunner.js";
import { TemplateExplorer } from "./components/TemplateExplorer.js";
import { TypedPlayground } from "./components/TypedPlayground.js";

export const SERVER = "everything";

type Tab = "prompts" | "templates" | "typed";

export function App() {
  const [tab, setTab] = useState<Tab>("prompts");
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const { state } = useServerState(SERVER);
  useMCPClient(); // assert provider presence early

  return (
    <div className="layout">
      <header>
        <h1>✳ Prompt Studio</h1>
        <span className="tagline">prompts as a product surface</span>
        <span className={`badge state-${state}`}>{state}</span>
        <nav>
          {(["prompts", "templates", "typed"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t === "prompts" ? "Prompts" : t === "templates" ? "Templates" : "Typed tools"}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "prompts" &&
          (activePrompt ? (
            <PromptRunner server={SERVER} name={activePrompt} onBack={() => setActivePrompt(null)} />
          ) : (
            <PromptGallery server={SERVER} onPick={setActivePrompt} />
          ))}
        {tab === "templates" && <TemplateExplorer server={SERVER} />}
        {tab === "typed" && <TypedPlayground />}
      </main>
    </div>
  );
}
