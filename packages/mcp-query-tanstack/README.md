# @johnhenry/mcp-query-tanstack

TanStack Query bridge for [`@johnhenry/mcp-query`](https://github.com/johnhenry/mcp-query) — `queryOptions`/`mutationOptions` factories that delegate fetching to mcp-query while syncing its own reactive cache into TanStack Query's, with zero extra refetches.

## Install

```sh
npm install @johnhenry/mcp-query-tanstack @johnhenry/mcp-query @tanstack/react-query react
```

`react` is a required peer, even though this package's own factories are framework-agnostic — `@tanstack/react-query`'s entrypoint imports `react` at module load time regardless of whether you ever call a hook, so it must be resolvable.

## Usage

```ts
import { QueryClient, useQuery } from "@tanstack/react-query";
import { MCPClient } from "@johnhenry/mcp-query";
import { mcpqToolQueryOptions } from "@johnhenry/mcp-query-tanstack";

const queryClient = new QueryClient();
const mcp-query = new MCPClient({ servers: { search: { transport: () => myTransport() } } });

function SearchResults({ q }: { q: string }) {
  const { data } = useQuery(mcpqToolQueryOptions(mcp-query, "search.query", { q }), queryClient);
  return <pre>{JSON.stringify(data)}</pre>;
}
```

`mcpqToolQueryOptions` bridges **read-only-hint** tools specifically — the TanStack-side analog of mcp-query's own `useToolResult` hook. For side-effecting tool calls, use `mcpqToolMutationOptions`.

## Skills over MCP

`mcpqSkillsQueryOptions(client, server)`, `mcpqSkillQueryOptions(client, uri, server)` and `mcpqSkillFileQueryOptions(client, skill, ref?)` bridge `client.listSkills` / `getSkill` / `readSkillFile` (SDK-verified skill files, see mcp-query's [Skills over MCP](https://github.com/johnhenry/mcp-query/blob/main/packages/mcp-query/docs/api.md#skills-over-mcp-iomodelcontextprotocolskills-sep-2640)). They need `@johnhenry/mcp-query` >= 0.6.0 and an SDK with `ext/skills` (>= 2.4.0); otherwise the query errors with the client's explanatory `MCPError`.

```ts
const { data: skills } = useQuery(mcpqSkillsQueryOptions(client, "docs"));
const { data: file } = useQuery(mcpqSkillFileQueryOptions(client, skills[0]!)); // SKILL.md, verified
```

Query keys live under `["mcp-query", server, "skills", ...]`; a file's key carries its manifest digest (`"dynamic"` for unverified dynamic skills, which get `staleTime: 0`), and a `partition` passed as `context: { partition }` is part of the key. A resources `list_changed` invalidates the bridged skills queries. With `skillApproval` on the client, the first file fetch asks the `InteractionBroker`; a denial is the query's error.

## How the sync bridge works

Every `queryOptions()` factory lazily registers a listener on mcp-query's own cache the first time a query actually runs (`ensureSynced`, or call `attachMcpqSync(client, queryClient)` explicitly up front). From then on, protocol push (`resources/updated`, `*_list_changed`) and optimistic `patch()`/rollback both mirror straight into TanStack Query's cache via `setQueryData` — no extra network round-trip. TanStack's own `staleTime`/`gcTime` still apply as a safety margin on top, but for an actively-rendered bridged query mcp-query's cache is the source of truth. When TanStack garbage-collects a query nobody renders anymore, the bridge releases its mcp-query-side subscription too (so a live MCP resource subscription doesn't leak).

## Scope

Tag-wide invalidation: protocol pushes and declared invalidations also call `queryClient.invalidateQueries` (via `tagToQueryKeyPrefix`) for bridged queries that have no live per-key subscription, using `client.cache.onExternalInvalidate` (requires `@johnhenry/mcp-query` >= 0.3.0).
