// Drill-down for a selected server: its tools (re-rendered on list_changed via
// useTools), each with a read-only "watch" toggle. Read-only tools (isReadOnly) get a
// WatchWidget; others are shown as call-only (no auto-watch — cockpit is observe-first).

import { useEffect, useState } from "react";
import { useTools, useResourceList, useServerState } from "mcp-query/react";
import { isReadOnly, type Tool } from "mcp-query";
import { JsonView } from "@app-shared";
import { WatchWidget } from "./WatchWidget.js";
import type { MCPClient } from "mcp-query";

export function DrillDown({ client, server }: { client: MCPClient; server: string }) {
  const { state } = useServerState(server);
  const { tools } = useTools({ server });
  const { resources } = useResourceList({ server });
  const [open, setOpen] = useState<string | null>(null);

  // Re-render on capability changes (list_changed). useTools already subscribes to the
  // caps cache, but we also nudge on the client's capability stream for resilience.
  const [, force] = useState(0);
  useEffect(() => client.subscribeCapabilities((s) => s === server && force((n) => n + 1)), [client, server]);

  if (state === "failed" || state === "closed") {
    return (
      <section className="drill">
        <h2 className="drill__title">{server}</h2>
        <p className="error">Server is {state}. Tools unavailable until it reconnects.</p>
      </section>
    );
  }

  return (
    <section className="drill">
      <h2 className="drill__title">
        {server} <span className="muted">· {tools.length} tools · {resources.length} resources</span>
      </h2>

      {tools.length === 0 ? (
        <p className="muted">{state === "ready" ? "no tools advertised" : `server is ${state}…`}</p>
      ) : (
        <ul className="toollist">
          {tools.map((t) => (
            <ToolRow
              key={t.name}
              tool={t}
              server={server}
              open={open === t.name}
              onToggle={() => setOpen((o) => (o === t.name ? null : t.name))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolRow({
  tool,
  server,
  open,
  onToggle,
}: {
  tool: Tool;
  server: string;
  open: boolean;
  onToggle: () => void;
}) {
  const readOnly = isReadOnly(tool);
  return (
    <li className={`toolrow${open ? " toolrow--open" : ""}`}>
      <button type="button" className="toolrow__head" onClick={onToggle}>
        <span className="toolrow__name">{tool.name}</span>
        {readOnly ? <span className="tag tag--ro">read-only</span> : <span className="tag tag--mut">mutating</span>}
        <span className="toolrow__chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="toolrow__body">
          {tool.description && <p className="toolrow__desc">{tool.description}</p>}
          {readOnly ? (
            <WatchWidget
              server={server}
              toolName={`${server}.${tool.name}`}
              inputSchema={tool.inputSchema as never}
            />
          ) : (
            <div className="toolrow__nowatch">
              <p className="muted">Mutating tool — not auto-watched. Schema:</p>
              <JsonView value={tool.inputSchema ?? { type: "object" }} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
