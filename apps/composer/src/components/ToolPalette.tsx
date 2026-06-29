// The "➕ Tool" palette: pick a connected server → pick a tool (or resource) → fill its
// inputSchema via SchemaForm → Run → the live MCP result becomes a draft block. This is
// the novel move: the USER drives the tool to produce grounded INPUT, not the agent.

import { useState } from "react";
import { SchemaForm, type JSONSchemaLike } from "@app-shared";
import { useMCPClient, useTools, useResourceList, useServerState } from "mcp-query/react";
import type { Tool, Resource } from "mcp-query";
import { nextId, type ToolBlock, type ResourceBlock } from "../draft.js";
import type { ServerEntry } from "../servers.js";

type Tab = "tools" | "resources";

export function ToolPalette({
  servers,
  onInsert,
  onClose,
}: {
  servers: ServerEntry[];
  /** Called with a fully-run block (result already populated). */
  onInsert: (block: ToolBlock | ResourceBlock) => void;
  onClose: () => void;
}) {
  const client = useMCPClient();
  const [server, setServer] = useState(servers[0]?.name ?? "");
  const [tab, setTab] = useState<Tab>("tools");
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reactive capability lists — refresh when the server connects or re-lists.
  const { state } = useServerState(server);
  const { tools } = useTools({ server });
  const { resources } = useResourceList({ server });

  async function runTool(values: Record<string, unknown>) {
    if (!selectedTool) return;
    setRunning(true);
    setError(null);
    try {
      const result = await client.callTool(`${server}.${selectedTool.name}`, values);
      onInsert({
        id: nextId("tool"),
        kind: "tool",
        server,
        tool: selectedTool.name,
        args: values,
        result,
      } satisfies ToolBlock);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function readResource(res: Resource) {
    setRunning(true);
    setError(null);
    try {
      const result = await client.readResource(res.uri, { server });
      onInsert({
        id: nextId("res"),
        kind: "resource",
        server,
        uri: res.uri,
        name: res.name,
        result,
      } satisfies ResourceBlock);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Tool palette">
        <header className="palette-head">
          <strong>Insert grounded block</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="palette-controls">
          <label className="field inline">
            <span>Server</span>
            <select
              value={server}
              onChange={(e) => {
                setServer(e.target.value);
                setSelectedTool(null);
              }}
            >
              {servers.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="tabs">
            <button className={tab === "tools" ? "tab active" : "tab"} onClick={() => setTab("tools")}>
              Tools
            </button>
            <button
              className={tab === "resources" ? "tab active" : "tab"}
              onClick={() => setTab("resources")}
            >
              Resources
            </button>
          </div>
        </div>

        <div className="palette-body">
          {tab === "tools" && (
            <div className="palette-list">
              {tools.length === 0 && (
                <p className="muted">
                  {state === "ready" ? "No tools on this server." : `Server is ${state}…`}
                </p>
              )}
              {tools.map((t) => (
                <button
                  key={t.name}
                  className={selectedTool?.name === t.name ? "list-item active" : "list-item"}
                  onClick={() => setSelectedTool(t)}
                >
                  <span className="list-name">{t.name}</span>
                  <span className="badges">
                    {t.annotations?.readOnlyHint === true && <span className="badge ro">read-only</span>}
                    {t.annotations?.destructiveHint === true && (
                      <span className="badge destructive">destructive</span>
                    )}
                  </span>
                  {t.description && <span className="list-desc">{t.description}</span>}
                </button>
              ))}
            </div>
          )}

          {tab === "resources" && (
            <div className="palette-list">
              {resources.length === 0 && <p className="muted">No resources.</p>}
              {resources.map((r) => (
                <button key={r.uri} className="list-item" onClick={() => void readResource(r)} disabled={running}>
                  <span className="list-name">{r.name ?? r.uri}</span>
                  <span className="list-desc">{r.uri}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "tools" && selectedTool && (
            <div className="palette-form">
              <h4>
                {selectedTool.name}
                {selectedTool.annotations?.destructiveHint === true && (
                  <span className="badge destructive">destructive</span>
                )}
              </h4>
              {selectedTool.description && <p className="muted small">{selectedTool.description}</p>}
              <SchemaForm
                schema={selectedTool.inputSchema as JSONSchemaLike | undefined}
                onSubmit={(v) => void runTool(v)}
                submitLabel={running ? "Running…" : "Run → insert"}
              />
            </div>
          )}

          {error && <p className="error-text">⚠ {error}</p>}
        </div>
      </div>
    </div>
  );
}
