// Devtools event protocol. The client emits these; a panel (in-app, or piped to a
// browser extension over postMessage / a WebSocket) renders them. Kept deliberately
// serializable so it can cross a process/iframe boundary like Apollo/React Query devtools.

import type { ServerCapabilities, ServerState } from "../core/types.js";

export type DevtoolsEvent =
  | { type: "server-state"; server: string; state: ServerState; capabilities?: ServerCapabilities }
  | { type: "capabilities"; server: string; kind: "tools" | "resources" | "prompts" }
  | { type: "invalidate"; keys: string[] }
  | { type: "request"; server: string; method: string; id: string; params?: unknown }
  | { type: "response"; server: string; id: string; ok: boolean; ms: number }
  | { type: "notification"; server: string; method: string; params?: unknown }
  | { type: "host-call"; server: string; kind: "sampling" | "elicitation" | "roots" };

export interface DevtoolsSink {
  emit(e: DevtoolsEvent): void;
}

/** A ring-buffer sink that also fans out to subscribers — what the Panel reads. */
export class DevtoolsHub implements DevtoolsSink {
  private buf: DevtoolsEvent[] = [];
  private subs = new Set<() => void>();
  constructor(private capacity = 500) {}

  emit(e: DevtoolsEvent): void {
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.shift();
    for (const fn of this.subs) fn();
  }
  events(): readonly DevtoolsEvent[] {
    return this.buf;
  }
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
