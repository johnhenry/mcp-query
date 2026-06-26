// useServerState — reactive connection lifecycle for a server, so a UI can show
// "github: reconnecting" / "degraded" / "ready". The dual of the capability hooks:
// they observe *what* a server offers, this observes *whether it's reachable*.

import { useCallback, useSyncExternalStore } from "react";
import { useMCPClient } from "./provider.js";
import type { ServerState } from "../core/types.js";

export interface UseServerStateResult {
  state: ServerState;
  isReady: boolean;
  /** Convenience capability probe (tools/resources/prompts/resources.subscribe). */
  supports: (feature: "tools" | "resources" | "prompts" | "resources.subscribe") => boolean;
}

export function useServerState(server: string): UseServerStateResult {
  const client = useMCPClient();
  useSyncExternalStore(
    useCallback((cb) => client.subscribeServerState(cb), [client]),
    () => client.serverStateVersion(),
    () => client.serverStateVersion(),
  );
  const state = client.serverState(server);
  const conn = client.connection(server);
  return {
    state,
    isReady: state === "ready",
    supports: (f) => conn?.supports(f) ?? false,
  };
}
