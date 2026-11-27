// Events fixture for MockMCPServer (io.modelcontextprotocol/events, SEP-3415).
// A controllable source: `emit` appends to a retained log, `truncate` drops history
// (so older cursors come back `truncated: true`), `fail` makes polls error, and the
// event-type list can change at runtime. The mock speaks the wire format directly
// (events/list, events/poll), so it works on every supported SDK. Poll only.

import { EVENTS_EXT, type EventOccurrence } from "../core/eventsExt.js";

export { EVENTS_EXT };

export interface MockEventType {
  name: string;
  description?: string;
  /** Advertised delivery modes. Default `["poll"]`. Only poll is served. */
  delivery?: string[];
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  /** Subscription filter: does `event.data` match the poll's `arguments`? Default: everything matches. */
  match?: (data: Record<string, unknown>, args: Record<string, unknown>) => boolean;
  /**
   * Replay (default true): cursors are positions in the retained log. With `false` the type has no
   * addressable history: `cursor` is always null and a poll returns (then clears) what was emitted since the last one.
   */
  replay?: boolean;
}

export interface MockEventsSpec {
  types: MockEventType[];
  /** Advertise `listChanged: true` (default true). */
  listChanged?: boolean;
  /** `nextPollMs` the server suggests (default 1000). `0` is allowed so tests need not wait. */
  nextPollMs?: number;
  /** Page size for events/list (default: all in one page). */
  listPageSize?: number;
}

/** What a poll looked like on the server side (for assertions). */
export interface MockPollRecord {
  name: string;
  arguments: unknown;
  cursor: unknown;
  maxAgeMs?: number;
  maxEvents?: number;
  /** The client's declared capabilities on this request, if any. */
  clientExtensions?: Record<string, unknown>;
}

interface LogEntry {
  seq: number;
  occurrence: EventOccurrence;
}

export class MockEventSource {
  /** Mutable: change `spec.types` (then call `server.notifyEventsListChanged()`) to simulate a dynamic list. */
  spec: MockEventsSpec;
  /** Every events/poll the server answered or refused. */
  polls: MockPollRecord[] = [];
  /** events/list requests seen. */
  listCalls = 0;

  private log: LogEntry[] = [];
  private seq = 0;
  /** Oldest sequence number still retained (entries below it were truncated away). */
  private floor = 1;
  private pending = new Map<string, EventOccurrence[]>();
  private failures: Array<{ error: unknown }> = [];

  constructor(spec: MockEventsSpec) {
    this.spec = spec;
  }

  /** Append an event. `eventId` defaults to `evt_<n>`; a repeated id models an upstream duplicate. */
  emit(name: string, data: Record<string, unknown> = {}, opts: { eventId?: string; timestamp?: string } = {}): EventOccurrence {
    const seq = ++this.seq;
    const occurrence: EventOccurrence = {
      eventId: opts.eventId ?? `evt_${seq}`,
      name,
      timestamp: opts.timestamp ?? new Date().toISOString(),
      data,
    };
    this.log.push({ seq, occurrence });
    const type = this.type(name);
    if (type && type.replay === false) {
      const q = this.pending.get(name) ?? [];
      q.push(occurrence);
      this.pending.set(name, q);
    }
    return occurrence;
  }

  /** Drop retained history (all of it, or all but the newest `keep`). Older cursors are then served `truncated: true`. */
  truncate(keep = 0): void {
    const drop = Math.max(0, this.log.length - keep);
    this.log.splice(0, drop);
    this.floor = this.log[0]?.seq ?? this.seq + 1;
  }

  /** Make the next `times` polls reject with `error` (a thrown value or a `{ code, message, data }` JSON-RPC error). */
  fail(error: unknown = new Error("mock events source unavailable"), times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ error });
  }

  /** The current head position as a cursor. */
  head(): string {
    return `c${this.seq}`;
  }

  type(name: string): MockEventType | undefined {
    return this.spec.types.find((t) => t.name === name);
  }

  /** events/list payload for one page. */
  list(cursor?: string): { events: unknown[]; nextCursor?: string } {
    this.listCalls++;
    const size = this.spec.listPageSize;
    const start = cursor ? Number(cursor) : 0;
    const types = size ? this.spec.types.slice(start, start + size) : this.spec.types;
    const next = size && start + size < this.spec.types.length ? String(start + size) : undefined;
    return {
      events: types.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        delivery: t.delivery ?? ["poll"],
        inputSchema: t.inputSchema ?? { type: "object" },
        payloadSchema: t.payloadSchema ?? { type: "object" },
      })),
      ...(next ? { nextCursor: next } : {}),
    };
  }

  /** Answer one events/poll. Throws `{ notFound }` for an unknown name (the server maps it to -32023). */
  poll(params: { name: string; arguments?: Record<string, unknown>; cursor?: string | null; maxAgeMs?: number; maxEvents?: number }, clientExtensions?: Record<string, unknown>) {
    this.polls.push({
      name: params.name,
      arguments: params.arguments,
      cursor: params.cursor,
      maxAgeMs: params.maxAgeMs,
      maxEvents: params.maxEvents,
      clientExtensions,
    });
    const failure = this.failures.shift();
    if (failure) throw failure.error;
    const type = this.type(params.name);
    if (!type) throw Object.assign(new Error(`unknown event ${params.name}`), { notFound: true });
    const args = params.arguments ?? {};
    const match = (e: EventOccurrence) => !type.match || type.match(e.data, args);
    const nextPollMs = this.spec.nextPollMs ?? 1000;

    if (type.replay === false) {
      const all = (this.pending.get(type.name) ?? []).filter(match);
      const take = params.maxEvents ? all.slice(0, params.maxEvents) : all;
      this.pending.set(type.name, (this.pending.get(type.name) ?? []).filter((e) => !take.includes(e)));
      return { resultType: "complete", events: take, cursor: null, truncated: false, hasMore: take.length < all.length, nextPollMs };
    }

    // "start from now": no events, a fresh cursor.
    if (params.cursor == null) {
      return { resultType: "complete", events: [], cursor: this.head(), truncated: false, hasMore: false, nextPollMs };
    }
    const after = Number(String(params.cursor).slice(1));
    // The retained log starts at `floor`: a cursor before `floor - 1` has lost events in between.
    const truncated = Number.isFinite(after) && after < this.floor - 1;
    const from = truncated ? this.floor - 1 : after;
    const candidates = this.log.filter((l) => l.seq > from && l.occurrence.name === type.name && match(l.occurrence));
    const batch = params.maxEvents ? candidates.slice(0, params.maxEvents) : candidates;
    const hasMore = batch.length < candidates.length;
    // Intermediate cursor when capped: the position of the last returned event, else the head.
    const cursor = hasMore ? `c${batch[batch.length - 1]!.seq}` : this.head();
    return {
      resultType: "complete",
      events: batch.map((l) => l.occurrence),
      cursor,
      truncated,
      hasMore,
      nextPollMs,
    };
  }
}
