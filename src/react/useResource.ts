// useResource — the useQuery analog. Reads a resource, caches it under its URI,
// auto-provides the URI tag, optionally subscribes for live updates, and re-fetches
// in the background when the entry goes stale (cache-and-network).

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMCPClient } from "./provider.js";
import type { CacheKey } from "../core/keys.js";
import type { MCPError, Tag } from "../core/types.js";

export interface UseResourceOptions<T> {
  server?: string;
  fetchPolicy?: "cache-first" | "cache-and-network" | "network-only";
  staleTime?: number;
  subscribe?: boolean;
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  select?: (raw: unknown) => T;
  /** Re-fetch on an interval (ms) — the real-time fallback for servers without subscribe. */
  refetchInterval?: number;
  /** Throw the in-flight promise so a <Suspense> boundary can show a fallback. */
  suspense?: boolean;
  /** Skip the read entirely (e.g. while a dependent value is undefined). */
  skip?: boolean;
}

export interface UseResourceResult<T> {
  data?: T;
  error?: MCPError;
  isLoading: boolean;
  isStale: boolean;
  refetch: () => Promise<void>;
}

export function useResource<T = unknown>(uri: string, opts: UseResourceOptions<T> = {}): UseResourceResult<T> {
  const client = useMCPClient();
  const { server, fetchPolicy = "cache-and-network", staleTime, subscribe, providesTags, select, skip, refetchInterval } = opts;
  const key: CacheKey = { kind: "resource", server: server ?? routeServer(client, uri), uri };

  // Observe a per-entry version counter (entries are mutated in place, so their
  // reference is stable — the version is what changes on each update).
  useSyncExternalStore(
    useCallback((cb) => client.cache.subscribe(key, cb), [client, uri, server]),
    () => client.cache.getVersion(key),
    () => client.cache.getVersion(key),
  );
  const entry = client.cache.getSnapshot(key);

  const refetch = useCallback(
    () => client.readResource(uri, { server, subscribe, staleTime, providesTags }).then(() => {}),
    [client, uri, server, subscribe, staleTime],
  );

  useEffect(() => {
    if (skip) return;
    const stale = client.cache.isStale(key);
    const haveData = entry?.status === "success";
    if (fetchPolicy === "network-only" || (fetchPolicy === "cache-first" && !haveData) || (fetchPolicy === "cache-and-network" && stale)) {
      void refetch();
    }
    // entry.isStale is the dependency that drives background refetch on invalidation.
  }, [skip, uri, server, fetchPolicy, entry?.isStale, refetch]);

  // Polling — the real-time fallback for servers that don't support resources/subscribe.
  useEffect(() => {
    if (skip || !refetchInterval) return;
    const id = setInterval(() => void refetch(), refetchInterval);
    return () => clearInterval(id);
  }, [skip, refetchInterval, refetch]);

  // Suspense: throw the in-flight promise (or kick one off) so a boundary can catch it.
  if (opts.suspense && !skip && entry?.status !== "success") {
    if (entry?.status === "error" && entry.error) throw entry.error;
    throw (
      client.cache.inflight(key) ??
      client.readResource(uri, { server, subscribe, staleTime, providesTags })
    );
  }

  const raw = entry?.data;
  return {
    data: raw === undefined ? undefined : select ? select(raw) : (raw as T),
    error: entry?.error,
    isLoading: !entry || entry.status === "fetching" || (entry.status === "idle" && !skip),
    isStale: client.cache.isStale(key),
    refetch,
  };
}

function routeServer(client: ReturnType<typeof useMCPClient>, uri: string): string {
  // Cheap pre-route so the cache key is stable before the async read resolves.
  const scheme = uri.split(":")[0];
  for (const c of client.connections()) if (c.resources.has(uri)) return c.name;
  return scheme ?? "default";
}
