// Top control bar: poll-interval control + an "add server" form (stdio / http / sse).
// New servers are persisted (localStorage) and dialed live via client.addServer.

import { useState } from "react";
import type { ServerEntry, TargetSpec } from "../lib/serverConfig.js";

export function ControlBar({
  intervalMs,
  onIntervalChange,
  onAdd,
  onReset,
}: {
  intervalMs: number;
  onIntervalChange: (ms: number) => void;
  onAdd: (entry: ServerEntry) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<TargetSpec["transport"]>("stdio");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("-y @modelcontextprotocol/server-everything");
  const [url, setUrl] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const spec: TargetSpec =
      transport === "stdio"
        ? { transport, command: command.trim(), args: argsText.trim() ? argsText.trim().split(/\s+/) : [] }
        : { transport, url: url.trim() };
    onAdd({ name: trimmed, spec });
    setName("");
    setOpen(false);
  }

  return (
    <div className="controlbar">
      <label className="controlbar__interval">
        poll
        <input
          type="number"
          min={500}
          step={500}
          value={intervalMs}
          onChange={(e) => onIntervalChange(Math.max(500, Number(e.target.value) || 500))}
        />
        ms
      </label>

      <button type="button" className="btn" onClick={() => setOpen((o) => !o)}>
        {open ? "cancel" : "+ add server"}
      </button>
      <button type="button" className="btn btn--ghost" onClick={onReset} title="Reset roster to defaults">
        reset
      </button>

      {open && (
        <form className="addform" onSubmit={submit}>
          <input className="addform__name" placeholder="name (e.g. github)" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={transport} onChange={(e) => setTransport(e.target.value as TargetSpec["transport"])}>
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
          {transport === "stdio" ? (
            <>
              <input placeholder="command" value={command} onChange={(e) => setCommand(e.target.value)} />
              <input placeholder="args (space-separated)" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            </>
          ) : (
            <input className="addform__url" placeholder="https://… (or mcp-gate endpoint)" value={url} onChange={(e) => setUrl(e.target.value)} />
          )}
          <button type="submit" className="btn">
            add
          </button>
        </form>
      )}
    </div>
  );
}
