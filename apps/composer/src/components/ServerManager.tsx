// Manage the multiplexed MCP servers: live connection state + add/remove. Adding a
// server calls client.addServer at runtime; removing calls client.removeServer.

import { useState } from "react";
import { useMCPClient } from "mcp-query/react";
import { useServerState } from "mcp-query/react";
import { WebSocketProxyTransport, type TargetSpec } from "@app-shared/transport";
import { useProxyToken } from "@app-shared";
import { specFromForm, type ServerEntry } from "../servers.js";

function ServerRow({
  entry,
  onRemove,
}: {
  entry: ServerEntry;
  onRemove: (name: string) => void;
}) {
  const { state } = useServerState(entry.name);
  return (
    <li className="server-row">
      <span className={`state-dot ${state}`} title={state} />
      <span className="server-name">{entry.name}</span>
      <span className="server-detail">
        {entry.spec.transport === "stdio"
          ? `${entry.spec.command ?? ""} ${(entry.spec.args ?? []).join(" ")}`.trim()
          : entry.spec.url}
      </span>
      <button className="mini danger" onClick={() => onRemove(entry.name)} title="Remove server">
        ✕
      </button>
    </li>
  );
}

export function ServerManager({
  servers,
  onAdd,
  onRemove,
}: {
  servers: ServerEntry[];
  onAdd: (entry: ServerEntry) => void;
  onRemove: (name: string) => void;
}) {
  const client = useMCPClient();
  const { url, token } = useProxyToken();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return setError("name is required");
    if (servers.some((s) => s.name === trimmed)) return setError("name already in use");
    const spec: TargetSpec | null = specFromForm({ kind, command, url: serverUrl });
    if (!spec) return setError(kind === "http" ? "url is required" : "command is required");

    setBusy(true);
    try {
      await client.addServer(trimmed, {
        transport: () => new WebSocketProxyTransport(url, token, spec),
      });
      onAdd({ name: trimmed, spec });
      setName("");
      setCommand("");
      setServerUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(serverName: string) {
    try {
      await client.removeServer(serverName);
    } catch {
      /* best-effort */
    }
    onRemove(serverName);
  }

  return (
    <div className="server-manager">
      <button className="link-btn" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Servers ({servers.length})
      </button>
      {open && (
        <div className="server-panel">
          <ul className="server-list">
            {servers.map((s) => (
              <ServerRow key={s.name} entry={s} onRemove={remove} />
            ))}
          </ul>

          <div className="add-server">
            <div className="add-row">
              <input
                placeholder="name (e.g. fs)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <select value={kind} onChange={(e) => setKind(e.target.value as "stdio" | "http")}>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
            </div>
            {kind === "stdio" ? (
              <input
                placeholder="command + args (e.g. npx -y @modelcontextprotocol/server-filesystem /tmp)"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            ) : (
              <input
                placeholder="https://host/mcp"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
            )}
            <button onClick={() => void add()} disabled={busy}>
              {busy ? "Connecting…" : "Add server"}
            </button>
            {error && <p className="error-text">⚠ {error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
