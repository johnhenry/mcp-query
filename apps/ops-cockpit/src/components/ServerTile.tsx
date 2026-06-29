// One NOC tile per connection. Live state (useServerState), latency (from the shared
// health poll), capability counts (useTools/useResourceList/usePromptList) and an
// inline SVG sparkline. Color-coded by tile status. Clicking drills into the server.

import { useServerState, useTools, useResourceList, usePromptList } from "mcp-query/react";
import { Sparkline } from "./Sparkline.js";
import { healthToTileStatus, statusColor, statusLabel } from "../lib/tile-status.js";
import type { ServerHealth } from "../hooks/useHealthPoll.js";

export function ServerTile({
  server,
  health,
  selected,
  onSelect,
}: {
  server: string;
  health?: ServerHealth;
  selected: boolean;
  onSelect: () => void;
}) {
  const { state } = useServerState(server);
  const { tools } = useTools({ server });
  const { resources } = useResourceList({ server });
  const { prompts } = usePromptList({ server });

  const status = healthToTileStatus(health?.snap ?? { state, ok: state === "ready" });
  const color = statusColor(status);
  const snap = health?.snap;
  const latency = snap?.ok && snap.pingMs !== undefined ? `${snap.pingMs} ms` : snap ? "—" : "…";

  return (
    <button
      type="button"
      className={`tile tile--${status}${selected ? " tile--selected" : ""}`}
      onClick={onSelect}
      style={{ borderColor: color }}
    >
      <header className="tile__head">
        <span className="tile__name">{server}</span>
        <span className="tile__badge" style={{ background: color }}>
          {statusLabel(status)}
        </span>
      </header>

      <div className="tile__state">
        <span className="dot" style={{ background: color }} />
        <span className="tile__statetext">{state}</span>
        <span className="tile__latency">{latency}</span>
      </div>

      <Sparkline history={health?.history ?? []} color={color} />

      <dl className="tile__caps">
        <div>
          <dt>tools</dt>
          <dd>{tools.length}</dd>
        </div>
        <div>
          <dt>resources</dt>
          <dd>{resources.length}</dd>
        </div>
        <div>
          <dt>prompts</dt>
          <dd>{prompts.length}</dd>
        </div>
      </dl>
    </button>
  );
}
