# @johnhenry/mcp-query-tanstack

## 0.1.0

### Minor Changes

- 25b09fd: Tag-wide invalidation: protocol pushes (`resources/updated`, `*/list_changed`, server-wide stale marks) and declared invalidations now call `queryClient.invalidateQueries` for TanStack-inactive bridged queries that have no live per-key subscription, via the new `cache.onExternalInvalidate` hook. Requires `@johnhenry/mcp-query` >=0.3.0 (peer range updated) (#24).

### Patch Changes

- Updated dependencies [25b09fd]
  - @johnhenry/mcp-query@0.3.0
