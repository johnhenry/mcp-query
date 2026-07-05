import { useState } from "react";
import { useServerState } from "@johnhenry/mcpq/react";
import { TENANTS, type Tenant } from "./tenants.js";
import { activeTenant } from "./trace.js";
import { TenantSwitcher } from "./components/TenantSwitcher.js";
import { CallDesk } from "./components/CallDesk.js";
import { TraceWaterfall } from "./components/TraceWaterfall.js";
import { PartitionInspector } from "./components/PartitionInspector.js";
import { ChaosPanel } from "./components/ChaosPanel.js";

declare global {
  const __GATE_CLI__: string;
  const __GATE_CONFIG__: string;
}

export function App() {
  const [tenant, setTenant] = useState<Tenant>(TENANTS[0]!);
  const gate = useServerState("gate");
  const direct = useServerState("context7-direct");

  const pick = (t: Tenant) => {
    activeTenant.id = t.id;
    activeTenant.user = t.user;
    setTenant(t);
  };

  return (
    <div className="layout">
      <header>
        <h1>⛭ Switchboard</h1>
        <span className="tagline">one governed endpoint, many tenants</span>
        <span className={`badge state-${gate.state}`}>gate: {gate.state}</span>
        <span className={`badge state-${direct.state}`}>direct: {direct.state}</span>
      </header>
      <div className="columns">
        <aside>
          <TenantSwitcher active={tenant} onPick={pick} />
          <ChaosPanel tenant={tenant} />
          <PartitionInspector />
        </aside>
        <main>
          <CallDesk tenant={tenant} />
        </main>
        <aside className="right">
          <TraceWaterfall />
        </aside>
      </div>
    </div>
  );
}
