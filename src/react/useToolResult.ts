// useToolResult — the query-shaped dual of useTool. Treats a (read-only) tool as a
// reactive, cached, auto-running query: same ergonomics as useResource but keyed by
// (tool, args). Use for tools annotated readOnlyHint (search, lookups, computed views).

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMCPClient } from "./provider.js";
import { argsHash, type CacheKey } from "../core/keys.js";
import type { MCPError, Tag } from "../core/types.js";

export interface UseToolResultOptions<A, T> {
  server?: string;
  /** Skip while args aren't ready. */
  skip?: boolean;
  fetchPolicy?: "cache-first" | "cache-and-network" | "network-only";
  select?: (raw: unknown) => T;
  providesTags?: Tag[] | ((result: unknown) => Tag[]);
  refetchInterval?: number;
  suspense?: boolean;
}

export function useToolResult<A extends Record<string, unknown>, T = unknown>(
  name: string,
  args: A,
  opts: UseToolResultOptions<A, T> = {},
): { data?: T; error?: MCPError; isLoading: boolean; isStale: boolean; refetch: () => Promise<void> } {
  const client = useMCPClient();
  const { server, skip, fetchPolicy = "cache-and-network", select, providesTags, refetchInterval } = opts;
  // Resolve the server eagerly so the cache key is stable before the call resolves.
  const resolved = server ?? resolveServer(client, name);
  const key: CacheKey = { kind: "toolResult", server: resolved, tool: bare(name), argsHash: argsHash(args) };

  useSyncExternalStore(
    useCallback((cb) => client.cache.subscribe(key, cb), [client, name, resolved, argsHash(args)]),
    () => client.cache.getVersion(key),
    () => client.cache.getVersion(key),
  );
  const entry = client.cache.getSnapshot(key);

  const refetch = useCallback(
    () => client.queryTool(name, args, { server, providesTags }).then(() => {}),
    [client, name, server, argsHash(args)],
  );

  useEffect(() => {
    if (skip) return;
    const stale = client.cache.isStale(key);
    const haveData = entry?.status === "success";
    if (
      fetchPolicy === "network-only" ||
      (fetchPolicy === "cache-first" && !haveData) ||
      (fetchPolicy === "cache-and-network" && stale)
    ) {
      void refetch();
    }
  }, [skip, name, resolved, fetchPolicy, entry?.isStale, refetch]);

  useEffect(() => {
    if (skip || !refetchInterval) return;
    const id = setInterval(() => void refetch(), refetchInterval);
    return () => clearInterval(id);
  }, [skip, refetchInterval, refetch]);

  if (opts.suspense && !skip && entry?.status !== "success") {
    if (entry?.status === "error" && entry.error) throw entry.error;
    throw client.cache.inflight(key) ?? client.queryTool(name, args, { server, providesTags });
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

function bare(name: string): string {
  return name.includes(".") ? name.split(".").slice(1).join(".") : name;
}
function resolveServer(client: ReturnType<typeof useMCPClient>, name: string): string {
  if (name.includes(".")) return name.split(".")[0]!;
  for (const c of client.connections()) if (c.tools.has(name)) return c.name;
  return "default";
}
