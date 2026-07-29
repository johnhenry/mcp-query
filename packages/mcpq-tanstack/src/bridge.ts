// Live sync bridge: mirrors mcpq's OWN cache writes — protocol push
// (resources/updated, *_list_changed), optimistic patch()/rollback, everything
// — straight into TanStack Query's cache via `setQueryData`. No extra refetch:
// for an actively-bridged query, mcpq's cache is the source of truth and
// TanStack Query is a reactively-synced mirror. `staleTime` stays a safety
// margin on top, not the primary freshness mechanism.
//
// Registration is lazy and memoized per (MCPClient, QueryClient, queryKey) —
// `ensureSynced` is called from inside each queryOptions() factory's queryFn,
// so a query starts syncing the first time it actually runs. Teardown is
// driven by TanStack's OWN lifecycle: a global `queryClient.getQueryCache()`
// listener (registered once per QueryClient) releases the mcpq-side
// `cache.subscribe()` ref (and whatever protocol subscription/gc that ref
// count drives) when TanStack garbage-collects the bridged query — so a
// bridged query that nobody renders anymore doesn't leak a live MCP resource
// subscription or an mcpq cache entry that never gc's.

import type { QueryClient } from "@tanstack/react-query";
import type { CacheKey, MCPClient } from "@johnhenry/mcpq";

interface SyncState {
  unsubs: Map<string, () => void>;
}

const syncState = new WeakMap<MCPClient, WeakMap<QueryClient, SyncState>>();

function keyOf(queryKey: readonly unknown[]): string {
  return JSON.stringify(queryKey);
}

function stateFor(mcpClient: MCPClient, queryClient: QueryClient): SyncState {
  let perQueryClient = syncState.get(mcpClient);
  if (!perQueryClient) syncState.set(mcpClient, (perQueryClient = new WeakMap()));
  let state = perQueryClient.get(queryClient);
  if (!state) {
    state = { unsubs: new Map() };
    perQueryClient.set(queryClient, state);
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "removed") return;
      const k = keyOf(event.query.queryKey);
      const unsubscribe = state!.unsubs.get(k);
      if (unsubscribe) {
        unsubscribe();
        state!.unsubs.delete(k);
      }
    });
  }
  return state;
}

/**
 * Register the live sync for one bridged query, once. Called internally by
 * every `queryOptions()` factory in this package — most consumers never call
 * this directly.
 */
export function ensureSynced(mcpClient: MCPClient, queryClient: QueryClient, cacheKey: CacheKey, queryKey: readonly unknown[]): void {
  const state = stateFor(mcpClient, queryClient);
  const k = keyOf(queryKey);
  if (state.unsubs.has(k)) return;
  const unsubscribe = mcpClient.cache.subscribe(cacheKey, () => {
    const entry = mcpClient.cache.getSnapshot(cacheKey);
    if (entry?.status === "success") queryClient.setQueryData(queryKey as unknown[], entry.data);
  });
  state.unsubs.set(k, unsubscribe);
}

/**
 * Explicitly wire the sync bridge for a `(client, queryClient)` pair ahead of
 * any query running (idempotent — safe to call multiple times, e.g. once at
 * app startup). Returns a teardown releasing every currently-bridged
 * subscription; individual queries still self-register lazily via
 * `queryOptions()` regardless of whether this was called.
 */
export function attachMcpqSync(mcpClient: MCPClient, queryClient: QueryClient): () => void {
  const state = stateFor(mcpClient, queryClient);
  return () => {
    for (const unsubscribe of state.unsubs.values()) unsubscribe();
    state.unsubs.clear();
  };
}
