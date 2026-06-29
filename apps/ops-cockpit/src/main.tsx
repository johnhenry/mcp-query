import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { makeProxyClient, AppProvider } from "@app-shared";
import { DevtoolsHub } from "mcp-query/devtools";
import { Cockpit } from "./Cockpit.js";
import { ActivityStore } from "./lib/activity.js";
import { loadServers, toSpecMap, type ServerEntry } from "./lib/serverConfig.js";
import "./styles.css";

function Root() {
  const [roster, setRoster] = useState<ServerEntry[]>(() => loadServers());

  // Build the client + activity wiring once. The roster used at boot dials those
  // servers through the proxy; later adds go through client.addServer (see Cockpit).
  const { client, activity } = useMemo(() => {
    const activity = new ActivityStore();
    const hub = new DevtoolsHub(2000);
    activity.attachHub(hub);
    const client = makeProxyClient({
      servers: toSpecMap(roster),
      hub,
      onCall: (e) => activity.push(e),
      clientInfo: { name: "ops-cockpit", version: "0.0.1" },
    });
    // Connect eagerly; per-server failures are isolated (tiles render the failed state).
    void client.connect();
    return { client, activity };
    // Intentionally boot-once: the roster snapshot at mount seeds the client. Runtime
    // roster changes are applied imperatively via client.addServer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppProvider client={client}>
      <Cockpit client={client} activity={activity} roster={roster} setRoster={setRoster} />
    </AppProvider>
  );
}

const root = document.getElementById("app")!;
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
