// Queue screen — a card per pending interaction.

import { useInteractions } from "mcp-query/react";
import { InteractionCard } from "./InteractionCard.js";

export function Queue() {
  const { interactions, resolve } = useInteractions();

  if (interactions.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon" aria-hidden>
          ✓
        </div>
        <h2>Queue is clear</h2>
        <p>No pending agent actions awaiting review.</p>
        <p className="empty-sub">Use “Simulate agent action” in the header to generate one.</p>
      </div>
    );
  }

  return (
    <div className="queue">
      {interactions.map((it) => (
        <InteractionCard key={it.id} interaction={it} resolve={resolve} />
      ))}
    </div>
  );
}
