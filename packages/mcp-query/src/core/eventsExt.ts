// The `io.modelcontextprotocol/events` extension (SEP-3415, stage Beta, protocol
// 2026-07-28+) — mcp-query-defined wire schemas. The official TypeScript SDK ships
// no Events runtime, so mcp-query drives these schemas over the SDK client's raw
// `request(…, schema)`, the way tasksExt.ts does for tasks (see eventsProbe.ts for
// the era-gate check).
//
// Every shape below was read from the extension spec, not from the issue:
//   https://github.com/modelcontextprotocol/ext-events/blob/c77b843/specification/beta/events/events.mdx
//   https://modelcontextprotocol.io/extensions/events
//   https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/3415-events-extension.md
// Schemas are loose (unknown fields pass through) so additive spec growth does not
// break a client. No `schema.ts` is published for this extension; the .mdx is normative.
//
// Implemented: `events/list`, `events/poll`, `notifications/events/list_changed`.
// Not implemented (wire shape is in the spec, the runtime is not here): `events/stream`
// (push) and `events/subscribe` / `events/unsubscribe` (webhook). See docs/api.md.

import * as z from "zod";

/** Extension identifier, as it appears under `capabilities.extensions`. */
export const EVENTS_EXT = "io.modelcontextprotocol/events";

/** The notification a server sends (on a `subscriptions/listen` stream) when its event types change. */
export const EVENTS_LIST_CHANGED = "notifications/events/list_changed";

/** The `subscriptions/listen` notification-filter field this extension adds. */
export const EVENTS_LIST_CHANGED_FILTER = "eventsListChanged";

/** JSON-RPC codes the extension defines (spec "Error Handling"). */
export const EVENTS_ERROR = {
  InvalidParams: -32602,
  /** Unknown event name (`data.kind: "event"`) or unknown subscription. */
  NotFound: -32023,
  /** Principal not permitted for this event + arguments, or access revoked. */
  Forbidden: -32024,
  /** Server-imposed limit or quota (`data.limit`, `data.max`). */
  ResourceExhausted: -32025,
  /** Well-formed but unsupported, e.g. a delivery mode the event type does not offer. */
  Unsupported: -32026,
  CallbackEndpointError: -32027,
  /** What a server that does not offer the extension answers any `events/*` with. */
  MethodNotFound: -32601,
} as const;

export const EventDeliverySchema = z.enum(["poll", "push", "webhook"]);
export type EventDelivery = z.infer<typeof EventDeliverySchema>;

/** One entry of `events/list`: an event type a server can deliver. */
export const EventTypeSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  /** Any non-empty subset of poll | push | webhook. Unknown future modes are kept as strings. */
  delivery: z.array(z.string()).default([]),
  /** JSON Schema for the subscription `arguments`. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  /** JSON Schema for `data` on delivered events. */
  payloadSchema: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type EventType = z.infer<typeof EventTypeSchema>;

/** `events/list` result (paginated like `tools/list`). */
export const ListEventsResultSchema = z.looseObject({
  events: z.array(EventTypeSchema),
  nextCursor: z.string().optional(),
});
export type ListEventsResult = z.infer<typeof ListEventsResultSchema>;

/** One delivered event. `cursor` is per-event on push/webhook only; poll carries it on the result. */
export const EventOccurrenceSchema = z.looseObject({
  /** Stable upstream id; the client dedupes on it within one subscription. */
  eventId: z.string(),
  name: z.string(),
  /** ISO 8601. */
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
  cursor: z.string().nullish(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export type EventOccurrence = z.infer<typeof EventOccurrenceSchema>;

/**
 * `events/poll` result. Spec: an absent `cursor` MUST be treated like `null` (event type
 * without replay); `truncated: true` means delivery started later than the supplied cursor
 * (a gap); `hasMore: true` means poll again immediately, ignoring `nextPollMs`.
 */
export const PollEventsResultSchema = z.looseObject({
  events: z.array(EventOccurrenceSchema).default([]),
  cursor: z.string().nullish(),
  truncated: z.boolean().optional(),
  hasMore: z.boolean().optional(),
  nextPollMs: z.number().optional(),
});
export type PollEventsResult = z.infer<typeof PollEventsResultSchema>;

/** `notifications/events/list_changed` carries no params of its own. */
export const EventsListChangedParamsSchema = z.looseObject({}).optional();

/** Errors that end a subscription (retrying cannot help). Anything else is retried with the cursor. */
export const TERMINAL_EVENT_CODES: readonly number[] = [
  EVENTS_ERROR.MethodNotFound,
  EVENTS_ERROR.InvalidParams,
  EVENTS_ERROR.NotFound,
  EVENTS_ERROR.Forbidden,
  EVENTS_ERROR.Unsupported,
  -32003, // AuthorizationError from an interceptor (mcp-query/server)
];
