// Hooks over the InteractionBroker. useInteractions() surfaces the pending
// approval/elicitation queue declaratively (render dialogs off it); useAuditLog()
// surfaces the trail. Both no-op gracefully when no broker is configured.
//
// Issue #18: thin re-exports of @johnhenry/agent-query-core's own generic
// useInteractions<D>/useAuditLog, parameterized by mcp-query's InteractionDecision — the
// generic machinery (useSyncExternalStore over broker.subscribe/getVersion) is
// identical to what these hooks used to inline.

import { useInteractions as coreUseInteractions, useAuditLog as coreUseAuditLog } from "@johnhenry/agent-query-core/react";
import { useMCPClient } from "./provider.js";
import type { AuditEntry, Interaction, InteractionDecision } from "../core/interactions.js";

export function useInteractions(): {
  interactions: Interaction[];
  resolve: (id: number, decision: InteractionDecision) => void;
} {
  const client = useMCPClient();
  return coreUseInteractions<InteractionDecision>(client.interactions);
}

export function useAuditLog(): readonly AuditEntry[] {
  const client = useMCPClient();
  return coreUseAuditLog(client.interactions);
}
