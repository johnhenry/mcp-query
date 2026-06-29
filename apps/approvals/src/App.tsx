// App shell: header (connection state + pending count + simulate control) and tabbed
// screens (Queue / Audit / Policy).

import { useState } from "react";
import { useInteractions, useServerState } from "mcp-query/react";
import { Queue } from "./components/Queue.js";
import { Audit } from "./components/Audit.js";
import { PolicyEditor } from "./components/PolicyEditor.js";
import { EVERYTHING_SERVER, getPolicyConfig } from "./broker.js";
import { simulate } from "./simulate.js";
import type { PolicyConfig } from "./policy.js";

type Tab = "queue" | "audit" | "policy";

export function App() {
  const [tab, setTab] = useState<Tab>("queue");
  const [policy, setPolicy] = useState<PolicyConfig>(getPolicyConfig());
  const [flash, setFlash] = useState<string | null>(null);

  const { interactions } = useInteractions();
  const { state } = useServerState(EVERYTHING_SERVER);
  const connected = state === "ready";

  async function onSimulate(kind: "sampling" | "elicitation" | "confirm"): Promise<void> {
    const label = await simulate(kind);
    setFlash(label);
    setTab("queue");
    window.setTimeout(() => setFlash(null), 4000);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ⬡
          </span>
          <div>
            <h1>Agent Approval Queue</h1>
            <p className="tagline">Human-in-the-loop oversight for MCP agents</p>
          </div>
        </div>

        <div className="status">
          <span className={`conn conn-${state}`}>
            <span className="conn-dot" aria-hidden />
            {connStateLabel(state)}
          </span>
          <span className="pending-count" title="Pending interactions">
            {interactions.length} pending
          </span>
        </div>
      </header>

      <nav className="tabs">
        <button className={tab === "queue" ? "tab active" : "tab"} onClick={() => setTab("queue")}>
          Queue
          {interactions.length > 0 && <span className="badge">{interactions.length}</span>}
        </button>
        <button className={tab === "audit" ? "tab active" : "tab"} onClick={() => setTab("audit")}>
          Audit
        </button>
        <button className={tab === "policy" ? "tab active" : "tab"} onClick={() => setTab("policy")}>
          Policy
        </button>

        <div className="simulate">
          <span className="sim-label">Simulate agent action:</span>
          <button className="btn btn-sim" disabled={!connected} onClick={() => onSimulate("sampling")}>
            Sampling
          </button>
          <button className="btn btn-sim" disabled={!connected} onClick={() => onSimulate("elicitation")}>
            Elicitation
          </button>
          <button className="btn btn-sim" onClick={() => onSimulate("confirm")}>
            Confirm
          </button>
        </div>
      </nav>

      {flash && <div className="flash">Triggered: {flash}</div>}

      <main className="content">
        {tab === "queue" && <Queue />}
        {tab === "audit" && <Audit />}
        {tab === "policy" && <PolicyEditor config={policy} onChange={setPolicy} />}
      </main>

      <footer className="footnote">
        Built on <code>mcp-query</code>’s <code>InteractionBroker</code> — manual sampling, response review,
        elicitation, and a trust policy in one queue.
      </footer>
    </div>
  );
}

function connStateLabel(state: string): string {
  switch (state) {
    case "ready":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "degraded":
      return "Degraded";
    case "failed":
      return "Disconnected";
    default:
      return state || "Idle";
  }
}
