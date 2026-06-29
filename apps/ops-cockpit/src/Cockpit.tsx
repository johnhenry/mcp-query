// The dashboard shell. Reads the live roster off the client (subscribeServerState so
// added/removed servers appear), polls health for the whole grid, and lays out the
// tile grid + drill-down + activity stream. Stays up even when individual servers fail.

import { useCallback, useState, useSyncExternalStore } from "react";
import type { MCPClient } from "mcp-query";
import { WebSocketProxyTransport } from "@app-shared/transport.js";
import { useHealthPoll } from "./hooks/useHealthPoll.js";
import { ServerTile } from "./components/ServerTile.js";
import { DrillDown } from "./components/DrillDown.js";
import { ActivityStream } from "./components/ActivityStream.js";
import { ControlBar } from "./components/ControlBar.js";
import type { ActivityStore } from "./lib/activity.js";
import { saveServers, type ServerEntry, DEFAULT_SERVERS } from "./lib/serverConfig.js";

export function Cockpit({
  client,
  activity,
  roster,
  setRoster,
}: {
  client: MCPClient;
  activity: ActivityStore;
  roster: ServerEntry[];
  setRoster: (r: ServerEntry[]) => void;
}) {
  const [intervalMs, setIntervalMs] = useState(2000);
  const [selected, setSelected] = useState<string | null>(null);

  // Subscribe to the state-version counter so added/removed/reconnecting servers
  // trigger a re-read of the connection list below.
  useSyncExternalStore(
    useCallback((cb) => client.subscribeServerState(cb), [client]),
    () => client.serverStateVersion(),
    () => client.serverStateVersion(),
  );
  const connections = safeConnections(client);

  const health = useHealthPoll(client, intervalMs);

  const handleAdd = useCallback(
    (entry: ServerEntry) => {
      const next = [...roster.filter((r) => r.name !== entry.name), entry];
      setRoster(next);
      saveServers(next);
      // Dial it live; failure is isolated (tile will show the failed state).
      void client.addServer(entry.name, { transport: newProxyTransport(entry) }).catch(() => {});
    },
    [client, roster, setRoster],
  );

  const handleReset = useCallback(() => {
    setRoster(DEFAULT_SERVERS);
    saveServers(DEFAULT_SERVERS);
  }, [setRoster]);

  return (
    <div className="cockpit">
      <header className="cockpit__top">
        <h1 className="cockpit__title">
          <span className="cockpit__logo">◉</span> Ops Cockpit
          <span className="cockpit__sub">{connections.length} servers</span>
        </h1>
        <ControlBar intervalMs={intervalMs} onIntervalChange={setIntervalMs} onAdd={handleAdd} onReset={handleReset} />
      </header>

      <main className="cockpit__body">
        <section className="grid">
          {connections.length === 0 ? (
            <p className="muted grid__empty">No servers connected. Add one above, or check the proxy is running.</p>
          ) : (
            connections.map((name) => (
              <ServerTile
                key={name}
                server={name}
                health={health[name]}
                selected={selected === name}
                onSelect={() => setSelected((s) => (s === name ? null : name))}
              />
            ))
          )}
        </section>

        <aside className="cockpit__side">
          {selected && connections.includes(selected) ? (
            <DrillDown client={client} server={selected} />
          ) : (
            <section className="drill drill--empty">
              <p className="muted">Select a tile to inspect its tools and start watching read-only ones.</p>
            </section>
          )}
          <ActivityStream store={activity} />
        </aside>
      </main>
    </div>
  );
}

function safeConnections(client: MCPClient): string[] {
  try {
    return client.connections().map((c) => c.name);
  } catch {
    return [];
  }
}

/** Re-derive a proxy transport factory (same wiring makeProxyClient uses) for a live add. */
function newProxyTransport(entry: ServerEntry) {
  const params = new URLSearchParams(location.search);
  const token = params.get("proxyToken") ?? "";
  const url = `ws://${location.hostname}:${params.get("proxyPort") ?? 6280}`;
  return () => new WebSocketProxyTransport(url, token, entry.spec);
}
