---
"@johnhenry/mcp-query-tanstack": minor
---

Add `mcpqSkillsQueryOptions`, `mcpqSkillQueryOptions` and `mcpqSkillFileQueryOptions` (Skills over MCP) following the existing queryOptions factories and sync bridge, plus `skillsQueryKey` / `skillQueryKey` / `skillFileQueryKey`. Keys nest under `["mcp-query", server, "skills", ...]` (file keys carry the manifest digest, partitions are part of the key), and a `skills:<server>` tag invalidation now also reaches queries with a live per-key subscription so a resources `list_changed` refetches the catalog. Needs `@johnhenry/mcp-query` >= 0.6.0 at call time; the peer range is unchanged.
