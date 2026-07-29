# @johnhenry/mcpq-tanstack

TanStack Query bridge for [`@johnhenry/mcpq`](https://github.com/johnhenry/mcp-query) — `queryOptions`/`mutationOptions` factories that delegate fetching to mcpq while syncing its own reactive cache into TanStack Query's, with zero extra refetches.

## Install

```sh
npm install @johnhenry/mcpq-tanstack @johnhenry/mcpq @tanstack/react-query react
```

`react` is a required peer, even though this package's own factories are framework-agnostic — `@tanstack/react-query`'s entrypoint imports `react` at module load time regardless of whether you ever call a hook, so it must be resolvable.

## Usage

```ts
import { QueryClient, useQuery } from "@tanstack/react-query";
import { MCPClient } from "@johnhenry/mcpq";
import { mcpqToolQueryOptions } from "@johnhenry/mcpq-tanstack";

const queryClient = new QueryClient();
const mcpq = new MCPClient({ servers: { search: { transport: () => myTransport() } } });

function SearchResults({ q }: { q: string }) {
  const { data } = useQuery(mcpqToolQueryOptions(mcpq, "search.query", { q }), queryClient);
  return <pre>{JSON.stringify(data)}</pre>;
}
```

`mcpqToolQueryOptions` bridges **read-only-hint** tools specifically — the TanStack-side analog of mcpq's own `useToolResult` hook. For side-effecting tool calls, use `mcpqToolMutationOptions`.

## How the sync bridge works

Every `queryOptions()` factory lazily registers a listener on mcpq's own cache the first time a query actually runs (`ensureSynced`, or call `attachMcpqSync(client, queryClient)` explicitly up front). From then on, protocol push (`resources/updated`, `*_list_changed`) and optimistic `patch()`/rollback both mirror straight into TanStack Query's cache via `setQueryData` — no extra network round-trip. TanStack's own `staleTime`/`gcTime` still apply as a safety margin on top, but for an actively-rendered bridged query mcpq's cache is the source of truth. When TanStack garbage-collects a query nobody renders anymore, the bridge releases its mcpq-side subscription too (so a live MCP resource subscription doesn't leak).

## Scope

v1 only — tag-wide `invalidateQueries` fallback for TanStack-inactive queries (`tagToQueryKeyPrefix` is exported, ready for it) needs a way to attach a listener to an already-constructed `MCPClient`'s cache, which doesn't exist on `MCPClientConfig` yet. Tracked as a follow-up issue once that lands.
