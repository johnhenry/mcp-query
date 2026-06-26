// Hooks over the InteractionBroker. useInteractions() surfaces the pending
// approval/elicitation queue declaratively (render dialogs off it); useAuditLog()
// surfaces the trail. Both no-op gracefully when no broker is configured.

import { useCallback, useSyncExternalStore } from "react";
import { useMCPClient } from "./provider.js";
import type { AuditEntry, Interaction, InteractionDecision } from "../core/interactions.js";

const noopUnsub = (): (() => void) => () => {};

export function useInteractions(): {
  interactions: Interaction[];
  resolve: (id: number, decision: InteractionDecision) => void;
} {
  const client = useMCPClient();
  const broker = client.interactions;
  const subscribe = useCallback((cb: () => void) => (broker ? broker.subscribe(cb) : noopUnsub()), [broker]);
  useSyncExternalStore(
    subscribe,
    () => broker?.getVersion() ?? 0,
    () => 0,
  );
  return {
    interactions: broker?.list() ?? [],
    resolve: (id, decision) => broker?.resolve(id, decision),
  };
}

export function useAuditLog(): readonly AuditEntry[] {
  const client = useMCPClient();
  const broker = client.interactions;
  const subscribe = useCallback((cb: () => void) => (broker ? broker.subscribe(cb) : noopUnsub()), [broker]);
  useSyncExternalStore(
    subscribe,
    () => broker?.getVersion() ?? 0,
    () => 0,
  );
  return broker?.auditLog() ?? [];
}
