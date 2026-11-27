// useEventTypes / useEvents — the Events extension (io.modelcontextprotocol/events, SEP-3415)
// as reactive data. `useEventTypes` is backed by the same cache as `client.listEvents`: a
// `notifications/events/list_changed` marks the listing stale and the hook re-fetches it.
// `useEvents` owns one `client.events(...)` poll subscription for the life of the component
// (closed on unmount or when its inputs change) and renders its snapshot.
// Needs a 2026-07-28 connection to a server that advertises the extension.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVersioned } from "@johnhenry/agent-query-core/react";
import { useMCPClient } from "./provider.js";
import { argsHash, type CacheKey } from "../core/keys.js";
import type { EventGap, EventSubscription, EventsOpts, EventsSnapshot, ServerEventType } from "../core/events.js";
import type { EventOccurrence } from "../core/eventsExt.js";
import { MCPError } from "../core/types.js";

export interface UseEventTypesOptions {
  /** Skip the fetch entirely. */
  skip?: boolean;
  /** Freshness window (ms); default is the server's `ttlMs`. */
  staleTime?: number;
}

export interface UseEventTypesResult {
  /** Event types of `server`, or the union across events-capable servers; every entry carries its `server`. */
  types: ServerEventType[];
  error?: MCPError;
  isLoading: boolean;
  isStale: boolean;
  refetch: () => Promise<void>;
}

function useTargets(server: string | undefined) {
  const client = useMCPClient();
  const versionOf = () => {
    let v = 0;
    for (const c of client.connections()) {
      if (server && c.name !== server) continue;
      v += client.cache.getVersion({ kind: "eventList", server: c.name });
    }
    return client.serverStateVersion() + v;
  };
  useVersioned(
    useCallback(
      (cb) => {
        const offState = client.subscribeServerState(cb);
        const offCache = client.cache.subscribeAll(cb);
        return () => {
          offState();
          offCache();
        };
      },
      [client],
    ),
    versionOf,
    versionOf,
  );
  const names = server
    ? [server]
    : client
        .connections()
        .filter((c) => c.supports("events"))
        .map((c) => c.name);
  return { client, names };
}

/** The event types a server (or every events-capable server) offers. Re-fetches after `list_changed`. */
export function useEventTypes(server?: string, opts: UseEventTypesOptions = {}): UseEventTypesResult {
  const { client, names } = useTargets(server);
  const keyOf = (s: string): CacheKey => ({ kind: "eventList", server: s });

  const refetch = useCallback(
    async () => {
      await Promise.all(names.map((s) => client.listEvents(s, { force: true, staleTime: opts.staleTime }).catch(() => {})));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, names.join("\0"), opts.staleTime],
  );

  // Fetch when missing or stale. Keyed on (success, stale) flags, NOT on the error state, so a
  // failing server is not re-requested in a loop.
  const flags = names
    .map((s) => {
      const e = client.cache.getSnapshot(keyOf(s));
      return `${e?.status === "success" ? 1 : 0}${client.cache.isStale(keyOf(s)) ? 1 : 0}`;
    })
    .join(",");
  useEffect(() => {
    if (opts.skip) return;
    for (const s of names) {
      if (client.cache.isStale(keyOf(s)) && !client.cache.inflight(keyOf(s))) {
        void client.listEvents(s, { staleTime: opts.staleTime }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, opts.skip, opts.staleTime, names.join("\0"), flags]);

  const entries = names.map((s) => client.cache.getSnapshot(keyOf(s)));
  return {
    types: entries.flatMap((e) => (e?.status === "success" ? ((e.data as ServerEventType[] | undefined) ?? []) : [])),
    error: entries.find((e) => e?.status === "error")?.error as MCPError | undefined,
    isLoading: !opts.skip && names.length > 0 && entries.some((e) => !e || e.status === "fetching" || e.status === "idle"),
    isStale: names.some((s) => client.cache.isStale(keyOf(s))),
    refetch,
  };
}

export interface UseEventsOptions extends Omit<EventsOpts, "onEvent" | "onGap" | "onCursor" | "signal"> {
  /** Do not subscribe. */
  skip?: boolean;
  /** Called for each new (deduped) event. Read through a ref: changing it does not resubscribe. */
  onEvent?: (event: EventOccurrence) => void;
  /** Called when the server reports a gap (`truncated: true`). */
  onGap?: (gap: EventGap) => void;
  /** Called when the resume cursor changes: persist it to resume after a reload. */
  onCursor?: (cursor: string | null) => void;
}

export interface UseEventsResult {
  /** Delivered events, oldest first, deduped on `eventId` (capped to `maxBuffer`). */
  events: readonly EventOccurrence[];
  status: EventsSnapshot["status"] | "idle";
  /** The resume position to persist. */
  cursor: string | null;
  /** Gaps the server reported (`truncated: true`); nothing here is silent. */
  gaps: readonly EventGap[];
  truncated: boolean;
  error?: MCPError;
  /** True while a poll has succeeded and the subscription is running. */
  isLive: boolean;
  /** Poll now. */
  refresh: () => void;
  /** End the subscription (it restarts if the inputs change). */
  close: () => void;
  snapshot?: EventsSnapshot;
}

const NOOP_SUBSCRIBE = () => () => {};
const NO_EVENTS: readonly EventOccurrence[] = [];
const NO_GAPS: readonly EventGap[] = [];

/**
 * Subscribe to one event type for the life of the component. `input` is the subscription
 * arguments (compared structurally: a new-but-equal object does not resubscribe).
 */
export function useEvents(
  server: string,
  name: string,
  input: Record<string, unknown> = {},
  opts: UseEventsOptions = {},
): UseEventsResult {
  const client = useMCPClient();
  const [sub, setSub] = useState<EventSubscription | undefined>();
  const [startError, setStartError] = useState<MCPError | undefined>();
  const cbs = useRef({ onEvent: opts.onEvent, onGap: opts.onGap, onCursor: opts.onCursor });
  cbs.current = { onEvent: opts.onEvent, onGap: opts.onGap, onCursor: opts.onCursor };
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const inputRef = useRef(input);
  inputRef.current = input;
  const inputKey = argsHash(input);

  useEffect(() => {
    if (opts.skip) {
      setSub(undefined);
      setStartError(undefined);
      return;
    }
    let s: EventSubscription | undefined;
    try {
      const { skip: _skip, onEvent: _a, onGap: _b, onCursor: _c, ...rest } = optsRef.current;
      s = client.events(server, name, inputRef.current, {
        ...rest,
        onEvent: (e) => cbs.current.onEvent?.(e),
        onGap: (g) => cbs.current.onGap?.(g),
        onCursor: (c) => cbs.current.onCursor?.(c),
      });
      setStartError(undefined);
    } catch (e) {
      setStartError(e instanceof MCPError ? e : new MCPError("protocol", e instanceof Error ? e.message : String(e), server));
      setSub(undefined);
      return;
    }
    setSub(s);
    return () => s?.close();
    // The cursor is an INITIAL position: changing it later must not restart the subscription.
  }, [client, server, name, inputKey, opts.skip, opts.mode, opts.maxAgeMs, opts.maxEvents, opts.pollFloorMs, opts.fallbackPollMs]);

  const snapshot = useSyncExternalStore(
    sub?.subscribe ?? NOOP_SUBSCRIBE,
    () => sub?.getSnapshot(),
    () => sub?.getSnapshot(),
  );

  return {
    events: snapshot?.events ?? NO_EVENTS,
    status: snapshot?.status ?? (startError ? "error" : "idle"),
    cursor: snapshot?.cursor ?? null,
    gaps: snapshot?.gaps ?? NO_GAPS,
    truncated: snapshot?.truncated ?? false,
    error: snapshot?.error ?? startError,
    isLive: snapshot?.status === "live",
    refresh: () => sub?.refresh(),
    close: () => sub?.close(),
    snapshot,
  };
}
