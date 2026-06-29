// Top-level Composer screen: builds the MCP client (multiplexed over the WS proxy),
// owns the thread + the working draft, and wires Send → assemble → stream the model.

import { useEffect, useMemo, useReducer, useState } from "react";
import { AppProvider, makeProxyClient } from "@app-shared";
import { Thread, type ThreadMessage } from "./components/Thread.js";
import { Composer } from "./components/Composer.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { ServerManager } from "./components/ServerManager.js";
import {
  draftReducer,
  emptyDraft,
  assembleMessage,
  nextId,
  type Draft,
} from "./draft.js";
import { loadServers, saveServers, toServerMap, type ServerEntry } from "./servers.js";
import {
  loadProviderConfig,
  saveProviderConfig,
  streamChat,
  type ChatMessage,
  type ProviderConfig,
} from "./model.js";

export function App() {
  const [servers, setServers] = useState<ServerEntry[]>(() => loadServers());
  // The client is built ONCE from the initially-saved servers; runtime add/remove go
  // through client.addServer/removeServer (handled in ServerManager).
  const initialServers = useMemo(() => toServerMap(loadServers()), []);
  const client = useMemo(
    () =>
      makeProxyClient({
        servers: initialServers,
        clientInfo: { name: "composer", version: "0.0.1" },
      }),
    [initialServers],
  );

  useEffect(() => {
    void client.connect();
    return () => void client.close();
  }, [client]);

  useEffect(() => saveServers(servers), [servers]);

  return (
    <AppProvider client={client}>
      <ComposerScreen servers={servers} setServers={setServers} />
    </AppProvider>
  );
}

function ComposerScreen({
  servers,
  setServers,
}: {
  servers: ServerEntry[];
  setServers: React.Dispatch<React.SetStateAction<ServerEntry[]>>;
}) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, dispatch] = useReducer(draftReducer, undefined, emptyDraft);
  const [modelConfig, setModelConfig] = useState<ProviderConfig>(() => loadProviderConfig());
  const [busy, setBusy] = useState(false);

  function updateModelConfig(next: ProviderConfig) {
    setModelConfig(next);
    saveProviderConfig(next);
  }

  function newChat() {
    setMessages([]);
    dispatch({ type: "clear" });
  }

  async function send() {
    if (busy) return;
    const assembled = assembleMessage(draft);
    if (!assembled.trim()) return;

    // Snapshot the draft blocks for the user message, then reset the composer.
    const blocks = draft.blocks.map((b) => ({ ...b }));
    const userMsg: ThreadMessage = { id: nextId("u"), role: "user", text: assembled, blocks };
    const assistantId = nextId("a");

    const history: ChatMessage[] = [
      ...messages.map((m) => ({ role: m.role, content: m.text }) as ChatMessage),
      { role: "user", content: assembled },
    ];

    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", text: "", streaming: true },
    ]);
    dispatch({ type: "clear" });
    setBusy(true);

    try {
      let acc = "";
      for await (const delta of streamChat(modelConfig, history)) {
        acc += delta;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, text: acc } : m)),
        );
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, streaming: false, error: message, text: m.text || "(no response)" }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="logo">◆</span> Composer
          <span className="tagline">tools as input</span>
        </div>
        <div className="header-controls">
          <ServerManager
            servers={servers}
            onAdd={(entry) => setServers((s) => [...s, entry])}
            onRemove={(name) => setServers((s) => s.filter((x) => x.name !== name))}
          />
          <ModelPicker config={modelConfig} onChange={updateModelConfig} />
          <button className="link-btn" onClick={newChat} title="New chat">
            ＋ New chat
          </button>
        </div>
      </header>

      <main className="app-main">
        <Thread messages={messages} />
      </main>

      <footer className="app-footer">
        <Composer
          draft={draft as Draft}
          dispatch={dispatch}
          servers={servers}
          onSend={() => void send()}
          busy={busy}
        />
      </footer>
    </div>
  );
}
