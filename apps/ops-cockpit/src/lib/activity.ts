// Unified activity stream. Two sources feed it: the client's `onCall` audit callback
// (durable read/call/query outcomes) and the DevtoolsHub event log (wire-level
// request/response/notification/server-state). We normalize both into one row shape,
// keep a capped ring buffer, and expose a useSyncExternalStore-friendly subscribe.

import type { CallAuditEntry } from "mcp-query";
import type { DevtoolsEvent, DevtoolsHub } from "mcp-query/devtools";

export interface ActivityRow {
  id: number;
  at: number;
  source: "audit" | "devtools";
  server: string;
  method: string;
  ok?: boolean;
  ms?: number;
  detail?: string;
}

/** The categories a row can be filtered by in the UI. */
export type ActivityFilter = "all" | "ok" | "error" | "audit" | "devtools";

export class ActivityStore {
  private rows: ActivityRow[] = [];
  private subs = new Set<() => void>();
  private seq = 0;
  private snapshot: readonly ActivityRow[] = [];

  constructor(private capacity = 300) {}

  /** Wire this as the `onCall` callback passed to makeProxyClient. */
  push = (entry: CallAuditEntry): void => {
    this.add({
      source: "audit",
      at: entry.at || Date.now(),
      server: entry.server,
      method: `${entry.kind} ${entry.target}`,
      ok: entry.outcome === "ok",
      ms: entry.ms,
      detail: entry.error,
    });
  };

  /** Subscribe to a DevtoolsHub and fold its events into this stream. */
  attachHub(hub: DevtoolsHub): () => void {
    let seen = hub.events().length;
    return hub.subscribe(() => {
      const events = hub.events();
      for (let i = seen; i < events.length; i++) this.fromDevtools(events[i]!);
      seen = events.length;
    });
  }

  private fromDevtools(e: DevtoolsEvent): void {
    switch (e.type) {
      case "response":
        this.add({ source: "devtools", at: Date.now(), server: e.server, method: `response #${e.id}`, ok: e.ok, ms: e.ms });
        break;
      case "request":
        this.add({ source: "devtools", at: Date.now(), server: e.server, method: e.method });
        break;
      case "notification":
        this.add({ source: "devtools", at: Date.now(), server: e.server, method: e.method });
        break;
      case "server-state":
        this.add({ source: "devtools", at: Date.now(), server: e.server, method: "server-state", detail: e.state });
        break;
      // other devtools events are intentionally not surfaced in the cockpit stream
      default:
        break;
    }
  }

  private add(partial: Omit<ActivityRow, "id">): void {
    const row: ActivityRow = { id: this.seq++, ...partial };
    this.rows.push(row);
    if (this.rows.length > this.capacity) this.rows.shift();
    this.snapshot = this.rows.slice().reverse(); // newest-first
    for (const fn of this.subs) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  /** Newest-first stable snapshot for useSyncExternalStore. */
  getSnapshot = (): readonly ActivityRow[] => this.snapshot;
}

/** Pure filter so it can be unit-tested and reused. */
export function filterRows(rows: readonly ActivityRow[], filter: ActivityFilter): readonly ActivityRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "ok":
      return rows.filter((r) => r.ok === true);
    case "error":
      return rows.filter((r) => r.ok === false);
    case "audit":
      return rows.filter((r) => r.source === "audit");
    case "devtools":
      return rows.filter((r) => r.source === "devtools");
  }
}
