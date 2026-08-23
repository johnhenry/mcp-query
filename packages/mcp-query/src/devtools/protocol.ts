// Devtools event protocol. The client emits these; a panel (in-app, or piped to a
// browser extension over postMessage / a WebSocket) renders them. Kept deliberately
// serializable so it can cross a process/iframe boundary like Apollo/React Query devtools.
//
// Issue #18: DevtoolsHub is now a thin subclass of @johnhenry/agent-query-core's generic
// DevtoolsHub<TEvent>. mcp-query's own DevtoolsEvent stays a closed, MCP-flavored union — every
// variant already carries a literal `type:` discriminant, so it satisfies core's
// `TEvent extends DevtoolsEventBase` constraint structurally, with zero changes to the
// union itself. Core's hub also gained getVersion() (mcp-query's Panel.tsx doesn't need it —
// it re-invokes hub.events() directly as its own snapshot — but it's available).

import { DevtoolsHub as CoreDevtoolsHub, type DevtoolsSink as CoreDevtoolsSink } from "@johnhenry/agent-query-core";
import type { ServerCapabilities, ServerState } from "../core/types.js";

export type DevtoolsEvent =
  | { type: "server-state"; server: string; state: ServerState; capabilities?: ServerCapabilities }
  | { type: "capabilities"; server: string; kind: "tools" | "resources" | "prompts" }
  | { type: "invalidate"; keys: string[] }
  | { type: "request"; server: string; method: string; id: string; params?: unknown; dir?: "in" | "out" }
  | { type: "response"; server: string; id: string; ok: boolean; ms: number; dir?: "in" | "out" }
  | { type: "notification"; server: string; method: string; params?: unknown; dir?: "in" | "out" }
  | { type: "host-call"; server: string; kind: "sampling" | "elicitation" | "roots" }
  | { type: "log"; server: string; level: string; data: unknown }
  | { type: "auth"; member: string; phase: string; detail?: unknown };

export type DevtoolsSink = CoreDevtoolsSink<DevtoolsEvent>;

/** A ring-buffer sink that also fans out to subscribers — what the Panel reads. */
export class DevtoolsHub extends CoreDevtoolsHub<DevtoolsEvent> {
  // Core's subscribe is a regular (unbound) method; mcp-query's own contract (see
  // test/inspector.test.ts) requires it to stay safely callable detached from `this` —
  // matching InteractionBroker.subscribe (an arrow property in core) and
  // MCPClient.subscribeServerState. Re-bind via an arrow-property override.
  override subscribe = (fn: () => void): (() => void) => super.subscribe(fn);
}
